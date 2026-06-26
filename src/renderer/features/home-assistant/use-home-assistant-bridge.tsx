// Lifecycle hook for the Home Assistant MQTT bridge. Starts the dedicated HA
// client from the broker config in the peerSync settings slice + the signed-in
// user, and restarts it when any of those change. Gated on
// `homeAssistant.enabled` AND a configured broker — independent of
// `peerSync.enabled`. Mounted (lazily) from audio-players alongside the
// peer-sync hook.

import { useEffect } from 'react';

import { startHaClient, stopHaClient } from './ha-mqtt-client';

import { useCurrentServer } from '/@/renderer/store/auth.store';
import { usePeerSyncSettings } from '/@/renderer/store/settings.store';

export const useHomeAssistantBridge = (): void => {
    const peerSync = usePeerSyncSettings();
    const server = useCurrentServer();

    const enabled = peerSync.homeAssistant?.enabled === true;
    const deviceName = peerSync.homeAssistant?.deviceName ?? '';
    const brokerUrl = peerSync.brokerUrl?.trim() ?? '';
    const { brokerPassword, brokerUsername, peerId, transport } = peerSync;
    // A peerSync.roomKeyOverride (when set) REPLACES the room identity — mirror
    // the peer-sync hook so the HA bridge joins the SAME overridden room
    // (namespace + broker auth) instead of the signed-in account's default.
    const roomKeyOverride = peerSync.roomKeyOverride?.trim() || '';
    const roomKey = roomKeyOverride || peerSync.roomKey;
    const userId = roomKeyOverride || (server?.userId ?? '');

    useEffect(() => {
        if (!enabled || !brokerUrl || !userId) {
            stopHaClient();
            return undefined;
        }
        startHaClient({
            brokerPassword,
            brokerUrl,
            brokerUsername,
            deviceName,
            peerId,
            roomKey,
            transport,
            userId,
        });
        return () => stopHaClient();
    }, [
        enabled,
        deviceName,
        brokerUrl,
        brokerUsername,
        brokerPassword,
        roomKey,
        transport,
        peerId,
        userId,
    ]);
};

export const HomeAssistantHook = (): null => {
    useHomeAssistantBridge();
    return null;
};
