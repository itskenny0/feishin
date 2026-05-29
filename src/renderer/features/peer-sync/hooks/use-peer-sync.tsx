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
import { shallow } from 'zustand/shallow';

import {
    isPeerClientConnected,
    publishPing,
    startPeerClient,
    stopPeerClient,
} from '/@/renderer/features/peer-sync/controller/peer-client';
import { applyPeerCommand } from '/@/renderer/features/peer-sync/controller/peer-receiver';
import { applyPeerStateToStore } from '/@/renderer/features/peer-sync/controller/peer-state-mirror';
import {
    pickTransport,
    setSyncEnabled,
    subscribe as subscribeTransport,
    sweepStalePresence,
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

const PRESENCE_SWEEP_MS = 3_000;
const PING_INTERVAL_MS = 8_000;

export const usePeerSync = () => {
    const peerSync = usePeerSyncSettings();
    const currentServer = useAuthStore((s) => s.currentServer, shallow);
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
        if (!peerSync.brokerUrl || !peerSync.peerId) {
            // The user has flipped the toggle on but the wizard hasn't yet
            // generated a peerId, or no broker URL was provided and we have
            // no embedded broker URL to fall back to. Stay silent — the
            // settings UI will surface the missing values. (We no longer
            // require a stored roomKey: it is derived from the Jellyfin
            // username below so a user's own devices auto-authenticate to
            // each other's broker.)
            return;
        }
        if (!currentServer || currentServer.type !== ServerType.JELLYFIN) {
            // Peer-sync namespace is keyed on Jellyfin user id; without a
            // signed-in Jellyfin user we have nothing meaningful to do.
            return;
        }
        if (!currentServer.userId || !currentServer.username) return;
        const tls = peerSync.brokerUrl.startsWith('wss://');
        log('booting client', {
            brokerUrl: peerSync.brokerUrl,
            peerId: peerSync.peerId,
            userId: currentServer.userId,
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
        const userIdForPings = currentServer.userId;

        startPeerClient(
            {
                brokerPassword: peerSync.brokerPassword,
                brokerUrl: peerSync.brokerUrl,
                brokerUsername: peerSync.brokerUsername,
                jellyfinDeviceId,
                peerId: peerSync.peerId,
                // The room key (== broker auth password against the embedded
                // broker) is deterministically the Jellyfin username. A random
                // per-install key would stop a user's own devices from
                // authenticating to each other's broker; deriving it from the
                // username means every device the same account signs into
                // shares the room automatically.
                roomKey: currentServer.username,
                tls,
                transport: peerSync.transport,
                userId: currentServer.userId,
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

        return () => {
            window.clearInterval(pingTimer);
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
        currentServer,
        jellyfinDeviceId,
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
