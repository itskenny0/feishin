import { useQueryClient } from '@tanstack/react-query';
import { createElement, useEffect, useRef } from 'react';

import { lyricsQueries } from '/@/renderer/features/lyrics/api/lyrics-api';
import {
    usePlayerStoreBase,
    usePrefetchUpcomingLyrics,
    usePrefetchUpcomingLyricsCount,
    useSettingsStore,
} from '/@/renderer/store';
import { QueueSong } from '/@/shared/types/domain-types';

const useUpcomingLyricsPrefetch = () => {
    const queryClient = useQueryClient();
    const enabled = usePrefetchUpcomingLyrics();
    const count = usePrefetchUpcomingLyricsCount();
    const inflightRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!enabled || count <= 0) return;

        const prefetchSongs = (songs: QueueSong[]) => {
            for (const song of songs) {
                if (!song?.id || !song?._serverId) continue;
                const cacheKey = `${song._serverId}:${song.id}`;
                if (inflightRef.current.has(cacheKey)) continue;

                inflightRef.current.add(cacheKey);
                queryClient
                    .prefetchQuery(
                        lyricsQueries.songLyrics(
                            {
                                query: { songId: song.id },
                                serverId: song._serverId,
                            },
                            song,
                        ),
                    )
                    .finally(() => inflightRef.current.delete(cacheKey));
            }
        };

        const upcomingFor = (state: ReturnType<typeof usePlayerStoreBase.getState>) => {
            const lyricsFetchEnabled = useSettingsStore.getState().lyrics.fetch;
            if (!lyricsFetchEnabled) return [];

            const queue = state.getQueue();
            const items = queue.items;
            const index = state.player.index;
            if (index < 0 || index >= items.length) return [];

            return items.slice(index + 1, index + 1 + count);
        };

        // Prefetch immediately for the current state, then re-prefetch on
        // every (currentSong, queueLength) change. We deliberately key on
        // both index/song-uniqueId AND queueLength so re-ordering or
        // appending tracks while a song is mid-play also warms the cache.
        prefetchSongs(upcomingFor(usePlayerStoreBase.getState()));

        const unsubscribe = usePlayerStoreBase.subscribe(
            (state) => {
                const items = state.getQueue().items;
                const index = state.player.index;
                return {
                    currentUniqueId: items[index]?._uniqueId,
                    queueLength: items.length,
                };
            },
            () => {
                prefetchSongs(upcomingFor(usePlayerStoreBase.getState()));
            },
            {
                equalityFn: (a, b) =>
                    a.currentUniqueId === b.currentUniqueId && a.queueLength === b.queueLength,
            },
        );

        return () => unsubscribe();
    }, [count, enabled, queryClient]);
};

const UpcomingLyricsPrefetchInner = () => {
    useUpcomingLyricsPrefetch();
    return null;
};

export const UpcomingLyricsPrefetch = () => {
    const enabled = usePrefetchUpcomingLyrics();
    if (!enabled) return null;
    return createElement(UpcomingLyricsPrefetchInner);
};
