import { useQueryClient } from '@tanstack/react-query';
import isEqual from 'lodash/isEqual';
import { useCallback } from 'react';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    getActiveCacheDb,
    isCacheAvailableSync,
    toCachedSongRow,
    writeSnapshot,
} from '/@/renderer/cache';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import {
    uniqueSeekToTimestamp,
    updateQueueSong,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { logger } from '/@/renderer/utils/logger';
import { QueueSong, SongDetailQuery } from '/@/shared/types/domain-types';

export const useUpdateCurrentSong = () => {
    const queryClient = useQueryClient();

    const handleSongChange = useCallback(
        async (properties: { index: number; song: QueueSong | undefined }) => {
            const currentSong = properties.song;

            if (!currentSong?.id || !currentSong?._serverId) {
                return;
            }

            try {
                const queryFilter: SongDetailQuery = { id: currentSong.id };
                const queryKey = queryKeys.songs.detail(currentSong._serverId, queryFilter);

                const updatedSong = await queryClient.fetchQuery({
                    queryFn: async ({ signal }) => {
                        const fresh = await api.controller.getSongDetail({
                            apiClientProps: {
                                serverId: currentSong._serverId,
                                signal,
                            },
                            query: queryFilter,
                        });
                        // Write-through to Dexie + snapshot so the next time
                        // anyone reads this song detail (queue restore, song
                        // detail route, etc.) the cache wins on first frame.
                        if (isCacheAvailableSync() && fresh) {
                            try {
                                const db = getActiveCacheDb();
                                if (db) await db.songs.put(toCachedSongRow(fresh));
                            } catch {
                                /* swallow */
                            }
                            writeSnapshot(queryKey, fresh);
                        }
                        return fresh;
                    },
                    queryKey,
                });

                if (updatedSong) {
                    const { _uniqueId, ...currentSongData } = currentSong;

                    if (!isEqual(currentSongData, updatedSong)) {
                        updateQueueSong(currentSong.id, updatedSong);

                        logger.debug('Differences found, updating song in queue', {
                            id: currentSong.id,
                            name: updatedSong.name,
                        });
                    }
                }
            } catch (error) {
                logger.error('Failed to update song in queue', {
                    error: error instanceof Error ? error.message : String(error),
                    id: currentSong.id,
                });
            }
        },
        [queryClient],
    );

    const resetSeekToTimestamp = useCallback(() => {
        usePlayerStoreBase.setState((state) => {
            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
        });
    }, []);

    usePlayerEvents(
        {
            onCurrentSongChange: (properties, prev) => {
                // Only update if the song actually changed
                if (
                    properties.song?.id !== prev.song?.id ||
                    properties.song?._uniqueId !== prev.song?._uniqueId
                ) {
                    handleSongChange(properties);
                    // Prevents issues with lingering seekToTimestamp on song autonext
                    resetSeekToTimestamp();
                }
            },
        },
        [handleSongChange, resetSeekToTimestamp],
    );
};

export const UpdateCurrentSongHook = () => {
    useUpdateCurrentSong();
    return null;
};
