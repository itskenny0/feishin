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

    useEffect(() => {
        setSyncEnabled(Boolean(peerSync.enabled && peerSync.jellyfinRemoteEnabled));
    }, [peerSync.enabled, peerSync.jellyfinRemoteEnabled]);

    useEffect(() => {
        if (!peerSync.enabled || !peerSync.jellyfinRemoteEnabled) {
            if (isPeerClientConnected()) stopPeerClient();
            return;
        }
        if (!peerSync.brokerUrl || !peerSync.peerId || !peerSync.roomKey) {
            // The user has flipped the toggle on but the wizard hasn't yet
            // generated a peerId / roomKey, or no broker URL was provided
            // and we have no embedded broker URL to fall back to. Stay
            // silent — the settings UI will surface the missing values.
            return;
        }
        if (!currentServer || currentServer.type !== ServerType.JELLYFIN) {
            // Peer-sync namespace is keyed on Jellyfin user id; without a
            // signed-in Jellyfin user we have nothing meaningful to do.
            return;
        }
        if (!currentServer.userId) return;
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
            const prev = prevTransport.get(peerId) ?? 'jellyfin';
            prevTransport.set(peerId, kind);
            recordTransportFlip(peerId, prev, kind);
        });
        const userIdForPings = currentServer.userId;

        startPeerClient(
            {
                brokerPassword: peerSync.brokerPassword,
                brokerUrl: peerSync.brokerUrl,
                brokerUsername: peerSync.brokerUsername,
                peerId: peerSync.peerId,
                roomKey: peerSync.roomKey,
                tls,
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
                    // already uses.
                    applyPeerStateToStore(state);
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
            if (isPeerClientConnected()) stopPeerClient();
        };
    }, [
        currentServer,
        peerSync.brokerPassword,
        peerSync.brokerUrl,
        peerSync.brokerUsername,
        peerSync.enabled,
        peerSync.jellyfinRemoteEnabled,
        peerSync.peerId,
        peerSync.roomKey,
    ]);

    // Presence sweeper — flips the transport selector back to Jellyfin
    // when a peer goes silent past the freshness window.
    useEffect(() => {
        if (!peerSync.enabled) return;
        const t = setInterval(() => sweepStalePresence(), PRESENCE_SWEEP_MS);
        return () => clearInterval(t);
    }, [peerSync.enabled]);

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
