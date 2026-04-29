import { useEffect, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';

import { createAuthHeader, jfApiClient } from '/@/renderer/api/jellyfin/jellyfin-api';
import { JF_FIELDS } from '/@/renderer/api/jellyfin/jellyfin-controller';
import { JellyfinRemoteController } from '/@/renderer/features/jellyfin-remote-control/controller/jellyfin-remote-controller';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerActions } from '/@/renderer/store/player.store';
import { usePlaybackSettings, useVolumeWheelStep } from '/@/renderer/store/settings.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { jfNormalize } from '/@/shared/api/jellyfin/jellyfin-normalize';
import { ServerType, Song } from '/@/shared/types/domain-types';

const controller = new JellyfinRemoteController();

export const useJellyfinRemoteControl = () => {
    const playerActions = usePlayerActions();
    const playerActionsRef = useRef(playerActions);
    playerActionsRef.current = playerActions;

    const volumeStep = useVolumeWheelStep();
    const volumeStepRef = useRef(volumeStep);
    volumeStepRef.current = volumeStep;

    const { jellyfinRemoteControl: enabled } = usePlaybackSettings();

    const currentServer = useAuthStore((s) => s.currentServer, shallow);
    const deviceId = useAuthStore((s) => s.deviceId);

    const serverKey = useMemo(() => {
        if (!currentServer) return null;
        if (currentServer.type !== ServerType.JELLYFIN) return null;
        if (!currentServer.credential) return null;
        return `${currentServer.id}:${currentServer.credential}:${currentServer.url}`;
    }, [currentServer]);

    useEffect(() => {
        if (!enabled || !serverKey || !currentServer || !deviceId) {
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

        const fetchSongsByIds = async (itemIds: string[]): Promise<Song[]> => {
            if (!currentServer.userId || itemIds.length === 0) return [];
            try {
                const res = await jfApiClient({ server: currentServer }).getSongList({
                    params: { userId: currentServer.userId },
                    query: {
                        Fields: JF_FIELDS.SONG,
                        Ids: itemIds.join(','),
                        IncludeItemTypes: 'Audio',
                        Limit: itemIds.length,
                        Recursive: true,
                    },
                });
                if (res.status !== 200) return [];
                const byId = new Map(
                    res.body.Items.map((item) => [item.Id, jfNormalize.song(item, currentServer)]),
                );
                return itemIds.map((id) => byId.get(id)).filter((s): s is Song => Boolean(s));
            } catch (err) {
                console.warn('[jellyfin-remote] fetchSongsByIds failed', err);
                return [];
            }
        };

        controller.start({
            authHeader,
            capabilitiesPayload: {
                DeviceProfile: null,
                MessageCallbackUrl: '',
                PlayableMediaTypes: ['Audio'],
                SupportedCommands: [
                    'VolumeUp',
                    'VolumeDown',
                    'Mute',
                    'Unmute',
                    'ToggleMute',
                    'SetVolume',
                    'DisplayMessage',
                    'Play',
                    'PlayNext',
                    'PlayLast',
                    'PlayMediaSource',
                ],
                SupportsMediaControl: true,
                SupportsPersistentIdentifier: true,
            },
            deviceId,
            dispatcherDeps: {
                defaultVolumeStep: volumeStepRef.current,
                fetchSongsByIds,
                playerActions: playerActionsRef.current,
            },
            serverUrl,
            token,
        });

        return () => {
            controller.stop();
        };
        // Refs above carry the latest playerActions/volume step into the
        // dispatcher, so we deliberately do not re-run on those changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, serverKey, deviceId]);
};

const JellyfinRemoteControlInner = () => {
    useJellyfinRemoteControl();
    return null;
};

export const JellyfinRemoteControlHook = JellyfinRemoteControlInner;
