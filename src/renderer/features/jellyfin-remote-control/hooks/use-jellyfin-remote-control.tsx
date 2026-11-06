import { useEffect, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';

import packageJson from '../../../../../package.json';

import { createAuthHeader, getDeviceLabel } from '/@/renderer/api/jellyfin/jellyfin-api';
import { JellyfinRemoteController } from '/@/renderer/features/jellyfin-remote-control/controller/jellyfin-remote-controller';
import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerActions } from '/@/renderer/store/player.store';
import {
    usePeerSyncSettings,
    usePlaybackSettings,
    useVolumeWheelStep,
} from '/@/renderer/store/settings.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { ServerType } from '/@/shared/types/domain-types';

const controller = new JellyfinRemoteController();

export const useJellyfinRemoteControl = () => {
    const playerActions = usePlayerActions();
    const playerActionsRef = useRef(playerActions);
    playerActionsRef.current = playerActions;

    const volumeStep = useVolumeWheelStep();
    const volumeStepRef = useRef(volumeStep);
    volumeStepRef.current = volumeStep;

    const { jellyfinRemoteControl: enabled } = usePlaybackSettings();
    const jellyfinRemoteEnabled = usePeerSyncSettings().jellyfinRemoteEnabled;

    const currentServer = useAuthStore((s) => s.currentServer, shallow);
    const deviceId = useAuthStore((s) => s.deviceId);

    const serverKey = useMemo(() => {
        if (!currentServer) return null;
        if (currentServer.type !== ServerType.JELLYFIN) return null;
        if (!currentServer.credential) return null;
        return `${currentServer.id}:${currentServer.credential}:${currentServer.url}`;
    }, [currentServer]);

    useEffect(() => {
        if (!enabled || !jellyfinRemoteEnabled || !serverKey || !currentServer || !deviceId) {
            controller.stop();
            return;
        }

        const baseUrl = getServerUrl(currentServer);
        if (!baseUrl) {
            controller.stop();
            return;
        }
        const serverUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const token = currentServer.credential;
        const authHeader = `${createAuthHeader()}, Token="${token}"`;

        // A rejection is logged + toasted by the dispatcher.
        const fetchSongsByIds = (itemIds: string[]) =>
            remoteTargetApi.hydrateSongs({ itemIds, server: currentServer });

        // Wrap player actions so the dispatcher reads the latest reference at
        // dispatch time, not at start() time — settings/store updates after
        // the socket opens then take effect immediately without restarting.
        const liveActionsProxy = new Proxy({} as (typeof playerActionsRef)['current'], {
            get: (_target, prop: string) => {
                const fn = (playerActionsRef.current as unknown as Record<string, unknown>)[prop];
                return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown) : undefined;
            },
        });

        // Reset the per-device queue cache on every server switch so the
        // sink can't carry stale ids over to a new library.
        sessionsSink.reset();

        controller.start({
            authHeader,
            capabilitiesPayload: {
                DeviceProfile: null,
                // Omit MessageCallbackUrl entirely. Sending an empty string
                // causes some Jellyfin versions to attempt callbacks against
                // the empty URL and log errors server-side.
                PlayableMediaTypes: ['Audio'],
                SupportedCommands: [
                    'VolumeUp',
                    'VolumeDown',
                    'Mute',
                    'Unmute',
                    'ToggleMute',
                    'SetVolume',
                    'SetRepeatMode',
                    'SetShuffleQueue',
                    'DisplayMessage',
                    // 'PlayMediaSource' is a Play command, not a
                    // GeneralCommand — advertising it caused Jellyfin to
                    // route real Play messages to a code path the dispatcher
                    // didn't handle. Removed.
                ],
                SupportsMediaControl: true,
                SupportsPersistentIdentifier: true,
            },
            client: 'Feishin',
            device: getDeviceLabel(),
            deviceId,
            dispatcherDeps: {
                // Read step fresh on every dispatch via getter so volume-step
                // setting changes propagate without a socket restart.
                get defaultVolumeStep() {
                    return volumeStepRef.current;
                },
                fetchSongsByIds,
                playerActions: liveActionsProxy,
            },
            // Push-side: every `Sessions` snapshot the server sends over the
            // WS lands here and feeds the controller's mirror in ~real time.
            // Without this the controller UI lags the receiver by up to the
            // poll cadence; with this it lags by the WS RTT (~tens of ms).
            onSessionsPayload: (sessions) => sessionsSink.apply(sessions, currentServer),
            serverUrl,
            subscribeToSessions: true,
            token,
            version: packageJson.version,
        });

        return () => {
            controller.stop();
        };
        // Refs above carry the latest playerActions/volume step into the
        // dispatcher, so we deliberately do not re-run on those changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, jellyfinRemoteEnabled, serverKey, deviceId]);
};

const JellyfinRemoteControlInner = () => {
    useJellyfinRemoteControl();
    return null;
};

export const JellyfinRemoteControlHook = JellyfinRemoteControlInner;
