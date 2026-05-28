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
import { useEffect } from 'react';
import { shallow } from 'zustand/shallow';

import {
    isPeerClientConnected,
    startPeerClient,
    stopPeerClient,
} from '/@/renderer/features/peer-sync/controller/peer-client';
import {
    applyPeerStateToStore,
    peerStateToMirrored,
} from '/@/renderer/features/peer-sync/controller/peer-state-mirror';
import {
    setSyncEnabled,
    sweepStalePresence,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePeerSyncSettings } from '/@/renderer/store/settings.store';
import { ServerType } from '/@/shared/types/domain-types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

const PRESENCE_SWEEP_MS = 3_000;

export const usePeerSync = () => {
    const peerSync = usePeerSyncSettings();
    const currentServer = useAuthStore((s) => s.currentServer, shallow);

    useEffect(() => {
        setSyncEnabled(Boolean(peerSync.enabled));
    }, [peerSync.enabled]);

    useEffect(() => {
        if (!peerSync.enabled) {
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
        startPeerClient(
            {
                brokerUrl: peerSync.brokerUrl,
                peerId: peerSync.peerId,
                roomKey: peerSync.roomKey,
                tls,
                userId: currentServer.userId,
            },
            {
                onConnectionChange: (status) => log('connection', { status }),
                onState: (_from, state) => {
                    // Forward into the existing remote-target store via the
                    // mirror seam — the same path the Jellyfin sessions-sink
                    // already uses.
                    applyPeerStateToStore(state);
                },
            },
        );
        return () => {
            if (isPeerClientConnected()) stopPeerClient();
        };
    }, [currentServer, peerSync.brokerUrl, peerSync.enabled, peerSync.peerId, peerSync.roomKey]);

    // Presence sweeper — flips the transport selector back to Jellyfin
    // when a peer goes silent past the freshness window.
    useEffect(() => {
        if (!peerSync.enabled) return;
        const t = setInterval(() => sweepStalePresence(), PRESENCE_SWEEP_MS);
        return () => clearInterval(t);
    }, [peerSync.enabled]);
};

export const PeerSyncHook = () => {
    usePeerSync();
    return null;
};

// Re-exported for tests / non-hook consumers.
export { peerStateToMirrored };
