import { t } from 'i18next';
import isElectron from 'is-electron';
import { useEffect, useRef } from 'react';

import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useRemotePush } from '/@/renderer/features/remote/hooks/use-remote-push';
import { useSetRating } from '/@/renderer/features/shared/hooks/use-set-rating';
import { useCreateFavorite } from '/@/renderer/features/shared/mutations/create-favorite-mutation';
import { useDeleteFavorite } from '/@/renderer/features/shared/mutations/delete-favorite-mutation';
import { usePlayerActions, useRemoteSettings } from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { logger } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';

const remote = isElectron() ? window.api.remote : null;

export const useRemote = () => {
    // Leaf subscription: pull the action handles directly instead of the
    // whole player slice. The previous bare `usePlayerStore()` re-rendered
    // this hook on every timestamp tick, queue mutation, and volume change,
    // which tore down and re-bound all the IPC listeners below.
    const { mediaSeekToTimestamp, setVolume } = usePlayerActions();

    const remoteSettings = useRemoteSettings();
    const setRating = useSetRating();
    const addToFavoritesMutation = useCreateFavorite({});
    const removeFromFavoritesMutation = useDeleteFavorite({});

    const isRemoteEnabled = remoteSettings.enabled;

    // Initialize the remote
    useEffect(() => {
        // we must send this EVEN IF the remote is disabled, as this is what
        // makes sure that the main process gets the port/username/password on startup

        logger.info('Initializing remote settings', {
            enabled: remoteSettings.enabled,
            port: remoteSettings.port,
            username: remoteSettings.username,
        });

        remote
            ?.updateSetting(
                remoteSettings.enabled,
                remoteSettings.port,
                remoteSettings.username,
                remoteSettings.password,
            )
            .catch((error) => {
                logger.error('Failed to enable remote', { error });
                toast.warn({
                    message: error,
                    title: t('error.remoteEnableError'),
                });
            });
        // We only want to fire this once
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!isRemoteEnabled || !remote) {
            return;
        }

        const offPosition = remote.requestPosition((data) => {
            logger.debug('Remote request position received', { position: data.position });
            const newTime = data.position;
            mediaSeekToTimestamp(newTime);
        });

        // No request-seek handler: the remote server never sends it, only
        // MPRIS does, and use-mpris already applies it - a second handler
        // here doubled every MPRIS Seek.
        const offRating = remote.requestRating((data) => {
            logger.debug('Remote request rating received', {
                id: data.id,
                rating: data.rating,
                serverId: data.serverId,
            });
            setRating(data.serverId, [data.id], LibraryItem.SONG, data.rating);
        });

        const offVolume = remote.requestVolume((data) => {
            logger.debug('Remote request volume received', { volume: data.volume });
            setVolume(data.volume);
        });

        const offFavorite = remote.requestFavorite((data) => {
            logger.debug('Remote request favorite received', {
                favorite: data.favorite,
                id: data.id,
                serverId: data.serverId,
            });
            const mutator = data.favorite ? addToFavoritesMutation : removeFromFavoritesMutation;
            mutator.mutate({
                apiClientProps: { serverId: data.serverId },
                query: {
                    id: [data.id],
                    type: LibraryItem.SONG,
                },
            });
        });

        // Per-listener unsubscribes: use-mpris shares request-position /
        // request-volume, so removeAllListeners would also drop its handlers.
        return () => {
            offPosition();
            offRating();
            offVolume();
            offFavorite();
        };
    }, [
        addToFavoritesMutation,
        isRemoteEnabled,
        mediaSeekToTimestamp,
        removeFromFavoritesMutation,
        setVolume,
        setRating,
    ]);

    // Send initial song if one is already playing
    const isInitializedRef = useRef(false);
    useEffect(() => {
        if (isInitializedRef.current || !isRemoteEnabled || !remote) {
            return;
        }

        isInitializedRef.current = true;

        // One-shot init: pull the current song imperatively so this effect
        // doesn't subscribe to player-state changes that would re-fire it
        // each time the queue / index / status mutates.
        const currentSong = usePlayerStoreBase.getState().getCurrentSong();

        if (currentSong) {
            logger.debug('Remote sending initial song', {
                artistName: currentSong.artistName,
                id: currentSong.id,
                name: currentSong.name,
            });

            const imageUrl =
                getItemImageUrl({
                    id: currentSong.id,
                    imageUrl: currentSong.imageUrl,
                    itemType: LibraryItem.SONG,
                    serverId: currentSong._serverId,
                    type: 'itemCard',
                    useRemoteUrl: true,
                }) || null;

            remote.updateSong(currentSong, imageUrl);
        }
    }, [isRemoteEnabled]);
};

export const RemoteHook = () => {
    useRemote();
    useRemotePush();
    return null;
};
