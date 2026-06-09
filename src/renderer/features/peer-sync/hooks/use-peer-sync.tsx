/**
 * Wires the peer-sync MQTT client into the renderer lifecycle.
 *
 *  - Boots the client when peer sync is enabled + a broker URL is configured
 *    + we're logged into a Jellyfin user (so the namespace is meaningful).
 *  - Stops it when any precondition flips false.
 *  - Toggles the transport selector's master switch in lockstep with the
 *    `enabled` setting so the dispatcher seam always agrees.
 *  - Runs a periodic presence sweep so a peer that goes silent ages out
 *    without us needing an LWT round-trip.
 *
 * Renders nothing. Mounted from `audio-players.tsx` alongside the other
 * background hooks (Discord RPC, scrobble, etc).
 */
import isElectron from 'is-electron';
import { useEffect } from 'react';

import { resolveEmbeddedBrokerUrl } from '/@/renderer/features/peer-sync/controller/embedded-broker-url';
import {
    isPeerClientConnected,
    publishPing,
    publishPresenceHeartbeat,
    startPeerClient,
    stopPeerClient,
} from '/@/renderer/features/peer-sync/controller/peer-client';
import {
    clearMqttCoalesce,
    warmMqttPublish,
} from '/@/renderer/features/peer-sync/controller/peer-dispatcher';
import { applyPeerCommand } from '/@/renderer/features/peer-sync/controller/peer-receiver';
import { applyPeerStateToStore } from '/@/renderer/features/peer-sync/controller/peer-state-mirror';
import {
    startStatePublisher,
    stopStatePublisher,
} from '/@/renderer/features/peer-sync/controller/state-publisher';
import {
    pickTransport,
    setSyncEnabled,
    subscribe as subscribeTransport,
    sweepStalePresence,
    touchPresence,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import {
    recordBrokerStatus,
    recordEmbeddedBroker,
    recordInboundCommand,
    recordInboundState,
    recordLatencySample,
    recordPresenceFrame,
    recordTransportFlip,
} from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePeerSyncSettings } from '/@/renderer/store/settings.store';
import { ServerType } from '/@/shared/types/domain-types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);
const warn = (...args: unknown[]) => console.warn('[peer-sync]', ...args);

const PRESENCE_SWEEP_MS = 3_000;
const PING_INTERVAL_MS = 8_000;
// SEV-1: republish our retained online presence at ~TTL/2 (MQTT_PRESENCE_TTL_MS
// is 12s) so remote selectors keep us fresh and never age the MQTT lane out
// while we're still connected. Kept under the TTL with margin for jitter.
const PRESENCE_HEARTBEAT_MS = 6_000;

export const usePeerSync = () => {
    const peerSync = usePeerSyncSettings();
    // Subscribe to the PRIMITIVE server fields the boot effect actually depends
    // on (id / type / userId / username) rather than the whole `currentServer`
    // object. `updateServer` mints a NEW object on every (re-)auth + server-info
    // refresh (isAdmin/features/version), so depending on the object reference
    // re-ran the effect and tore the live MQTT client down on every refresh —
    // the "connected, then disconnected" symptom. Primitive deps stay stable
    // across those refreshes so the client is built once and kept.
    const serverId = useAuthStore((s) => s.currentServer?.id);
    const serverType = useAuthStore((s) => s.currentServer?.type);
    const serverUserId = useAuthStore((s) => s.currentServer?.userId);
    const serverUsername = useAuthStore((s) => s.currentServer?.username);
    // The local Jellyfin Sessions deviceId — same id our server reports in
    // its /Sessions response under DeviceId. We publish it in our presence
    // frame so remote pickers can bridge "this Jellyfin device row" to
    // "this MQTT peer" and upgrade the command lane.
    const jellyfinDeviceId = useAuthStore((s) => s.deviceId);

    useEffect(() => {
        setSyncEnabled(
            Boolean(peerSync.enabled && peerSync.jellyfinRemoteEnabled && peerSync.onboarded),
        );
    }, [peerSync.enabled, peerSync.jellyfinRemoteEnabled, peerSync.onboarded]);

    useEffect(() => {
        // The wizard is the single source of truth — boot only after the user
        // explicitly completed onboarding, regardless of how `enabled` flipped
        // true (settings restore, migration, etc).
        if (!peerSync.enabled || !peerSync.jellyfinRemoteEnabled || !peerSync.onboarded) {
            // Tear down unconditionally — stopPeerClient is idempotent (no-ops
            // when there is no session) and must run even mid-handshake. Gating
            // on isPeerClientConnected() leaked a still-connecting client past
            // the kill switch: it would fire 'connect' and publish presence
            // after we were told to stop. See C3.
            stopPeerClient();
            return;
        }
        // The embedded broker tier persists `brokerUrl: ''` (the broker is
        // auto-started locally with no user-typed URL — see connect-wizard's
        // handleFinish). Reconstruct the loopback ws(s):// URL from the same
        // broker config it was started with so the client actually connects
        // instead of treating an empty brokerUrl as "not configured".
        const embeddedBrokerUrl = peerSync.broker.enabled
            ? resolveEmbeddedBrokerUrl({
                  host: peerSync.broker.host,
                  port: peerSync.broker.port,
                  tlsCertPath: peerSync.broker.tlsCertPath,
                  tlsKeyPath: peerSync.broker.tlsKeyPath,
              })
            : null;
        const effectiveBrokerUrl = peerSync.brokerUrl || embeddedBrokerUrl;
        if (!effectiveBrokerUrl || !peerSync.peerId) {
            // The user flipped the toggle on but we have nothing to dial:
            // either the wizard hasn't generated a peerId yet, or there is no
            // configured broker URL AND the embedded broker isn't enabled. Log
            // why we're idle so "MQTT never connects" is diagnosable from the
            // console instead of failing silently. (We no longer require a
            // stored roomKey: it is derived from the Jellyfin username below so
            // a user's own devices auto-authenticate to each other's broker.)
            warn('not connecting:', {
                reason: !peerSync.peerId
                    ? 'no peerId (re-run the Connect wizard)'
                    : 'no broker URL and embedded broker is not enabled',
            });
            return;
        }
        if (!serverId || serverType !== ServerType.JELLYFIN) {
            // Peer-sync namespace is keyed on Jellyfin user id; without a
            // signed-in Jellyfin user we have nothing meaningful to do.
            warn('not connecting:', { reason: 'no signed-in Jellyfin server' });
            return;
        }
        if (!serverUserId || !serverUsername) {
            warn('not connecting:', { reason: 'Jellyfin server has no userId/username' });
            return;
        }
        // Warm the lazily-loaded MQTT publish seam so peerDispatcher's
        // command path is synchronous by the time a peer is live. Cheap: it
        // shares the vendor-mqtt chunk this hook already pulled in.
        void warmMqttPublish().catch(() => {});
        const tls = effectiveBrokerUrl.startsWith('wss://');
        log('booting client', {
            brokerUrl: effectiveBrokerUrl,
            embedded: !peerSync.brokerUrl && Boolean(embeddedBrokerUrl),
            peerId: peerSync.peerId,
            userId: serverUserId,
        });
        // Pending pings keyed by id: timestamp captured at publish so the
        // matching pong can compute round-trip in ms. Cleared on stop.
        const pendingPings = new Map<string, { peerId: string; ts: number }>();
        // Known peers (any we've seen presence for), used to drive periodic
        // pings + transport-flip tracking. Populated by onPresence below.
        const knownPeers = new Set<string>();
        // Previous transport per peer for flip detection. Seeded lazily when
        // the selector first reports a peer.
        const prevTransport = new Map<string, ReturnType<typeof pickTransport>>();
        const unsubscribeTransport = subscribeTransport((peerId, kind) => {
            // Match the selector's first-observation convention
            // (transport-selector.ts: `if (prev !== undefined) log('transport
            // flip', ...)`). An unseen peer's first notification is NOT a flip,
            // so don't seed a fake 'jellyfin' prior — that inflated the
            // diagnostics flip count with a phantom jellyfin->mqtt entry the
            // console never logged. See B6.
            const prev = prevTransport.get(peerId);
            prevTransport.set(peerId, kind);
            if (prev !== undefined) recordTransportFlip(peerId, prev, kind);
        });
        const userIdForPings = serverUserId;

        startPeerClient(
            {
                brokerPassword: peerSync.brokerPassword,
                brokerUrl: effectiveBrokerUrl,
                brokerUsername: peerSync.brokerUsername,
                jellyfinDeviceId,
                peerId: peerSync.peerId,
                // The room key (== broker auth password against the embedded
                // broker) is deterministically the Jellyfin username. A random
                // per-install key would stop a user's own devices from
                // authenticating to each other's broker; deriving it from the
                // username means every device the same account signs into
                // shares the room automatically.
                roomKey: serverUsername,
                tls,
                transport: peerSync.transport,
                userId: serverUserId,
            },
            {
                onCommand: (from, cmd) => {
                    // Diagnostics first — every inbound frame counts
                    // toward the recent-commands list whether or not we
                    // actually applied it. The receiver then runs the
                    // authorisation gate and, if it passes, mutates the
                    // local player store. See peer-receiver.ts for the
                    // verb → action mapping table.
                    recordInboundCommand(from.peerId, cmd);
                    applyPeerCommand(from, cmd);
                },
                onConnectionChange: (status) => {
                    log('connection', { status });
                    recordBrokerStatus(status);
                },
                onPong: (from, pong) => {
                    // SEV-1: a successful RTT probe proves the peer is still
                    // alive, so refresh its freshness in the transport selector.
                    // touchPresence bumps only lastSeenAt — it deliberately does
                    // NOT re-run recordPresence (which would clear the dev bridge
                    // when the pong carries no `dev`; see SEV-4). This keeps the
                    // MQTT lane up even between presence heartbeats.
                    touchPresence(from.peerId);
                    const pending = pendingPings.get(pong.id);
                    if (!pending) return;
                    pendingPings.delete(pong.id);
                    recordLatencySample(from.peerId, Date.now() - pending.ts);
                },
                onPresence: (from, presence) => {
                    recordPresenceFrame(from.peerId, presence);
                    if (presence.online) knownPeers.add(from.peerId);
                    else knownPeers.delete(from.peerId);
                },
                onState: (from, state) => {
                    // Forward into the existing remote-target store via the
                    // mirror seam — the same path the Jellyfin sessions-sink
                    // already uses. The mirror gates on `from` so a non-target
                    // peer's frame can't clobber our picked target's state.
                    applyPeerStateToStore(from, state);
                    recordInboundState(from.peerId, state);
                },
            },
        );

        // D1 / SEV-2: mirror the local player onto the `state` topic so a peer
        // that picks THIS instance as its Connect target can actually reflect
        // our playback. Without this the entire receive-side mirror (gates, RTT
        // offset, stub queue) is dead code. The publisher self-gates on
        // isSyncEnabled() + connection and routes through publishOwnState, which
        // consults the loop guard, so an inbound-apply window suppresses echoes.
        startStatePublisher();

        // Liveness probes. Ping every known online peer on an interval; the
        // pong's arrival flips the latency sample. We don't ping when the
        // client itself isn't connected — pongs would never come back.
        const pingTimer = window.setInterval(() => {
            if (!isPeerClientConnected()) return;
            // Drop probes older than 30s so pendingPings doesn't leak when a
            // peer goes silent without disconnecting cleanly.
            const cutoff = Date.now() - 30_000;
            for (const [id, p] of pendingPings) {
                if (p.ts < cutoff) pendingPings.delete(id);
            }
            for (const peerId of knownPeers) {
                const id = publishPing({ peerId, userId: userIdForPings });
                if (id) pendingPings.set(id, { peerId, ts: Date.now() });
            }
        }, PING_INTERVAL_MS);

        // SEV-1: retained presence heartbeat. Without it our presence is only
        // ever published once (the connect handler), so every OTHER peer's
        // transport-selector freezes our lastSeenAt and ages the MQTT lane out
        // ~12s later even though we're still connected. Republishing the
        // retained online frame at TTL/2 keeps remote selectors fresh and lets
        // a late joiner learn our live dev bridge immediately.
        const heartbeatTimer = window.setInterval(() => {
            if (!isPeerClientConnected()) return;
            publishPresenceHeartbeat();
        }, PRESENCE_HEARTBEAT_MS);

        return () => {
            window.clearInterval(pingTimer);
            window.clearInterval(heartbeatTimer);
            stopStatePublisher();
            clearMqttCoalesce();
            unsubscribeTransport();
            pendingPings.clear();
            knownPeers.clear();
            prevTransport.clear();
            recordBrokerStatus('disconnected');
            // Unconditional — a client that is still mid-handshake (connect
            // event not yet fired) must also be torn down so it can't go live
            // after cleanup. stopPeerClient is null-guarded/idempotent. See C3.
            stopPeerClient();
        };
    }, [
        serverId,
        serverType,
        serverUserId,
        serverUsername,
        jellyfinDeviceId,
        peerSync.broker.enabled,
        peerSync.broker.host,
        peerSync.broker.port,
        peerSync.broker.tlsCertPath,
        peerSync.broker.tlsKeyPath,
        peerSync.brokerPassword,
        peerSync.brokerUrl,
        peerSync.brokerUsername,
        peerSync.enabled,
        peerSync.jellyfinRemoteEnabled,
        peerSync.onboarded,
        peerSync.peerId,
        peerSync.transport,
    ]);

    // Presence sweeper — flips the transport selector back to Jellyfin
    // when a peer goes silent past the freshness window. Gated/deps aligned
    // with the master switch (enabled && jellyfinRemoteEnabled && onboarded)
    // so the no-op timer stops firing when the kill switch or onboarding flips
    // off and the client is torn down. See C5.
    useEffect(() => {
        if (!(peerSync.enabled && peerSync.jellyfinRemoteEnabled && peerSync.onboarded)) return;
        const t = setInterval(() => sweepStalePresence(), PRESENCE_SWEEP_MS);
        return () => clearInterval(t);
    }, [peerSync.enabled, peerSync.jellyfinRemoteEnabled, peerSync.onboarded]);

    // Poll the main-process embedded broker for status. Cheap IPC; runs at a
    // slower cadence than the renderer pings since the value rarely changes.
    useEffect(() => {
        if (!isElectron()) return;
        const api = window.api.peerBroker;
        if (!api) return;
        let mounted = true;
        const tick = async () => {
            try {
                const s = await api.status();
                if (!mounted) return;
                recordEmbeddedBroker({
                    enabled: Boolean(peerSync.broker.enabled),
                    listenAddress: s.listenAddress,
                    running: s.running,
                });
            } catch {
                // IPC failure on the broker channel just means we don't
                // surface an embedded-broker status this tick; not worth
                // toasting.
            }
        };
        void tick();
        const t = window.setInterval(tick, 4_000);
        return () => {
            mounted = false;
            window.clearInterval(t);
        };
    }, [peerSync.broker.enabled]);
};

export const PeerSyncHook = () => {
    usePeerSync();
    return null;
};
