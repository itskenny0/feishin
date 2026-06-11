import { useEffect, useRef } from 'react';

import { resolveThumbnail } from '/@/renderer/cache';
import { getItemImageRequest } from '/@/renderer/components/item-image/item-image';
import { waitForPlaybackFlowing } from '/@/renderer/features/trackmap/analysis/defer-until-playing';
import { getIsOnline } from '/@/renderer/lib/network-status';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { LibraryItem } from '/@/shared/types/domain-types';

/** How many upcoming queue items get their cover warmed. */
const PREFETCH_COUNT = 2;
/** fullScreen covers are a few hundred KB — bound the recall set anyway. */
const PREFETCHED_RECALL_LIMIT = 300;
/** The variant the fullscreen player resolves (imageRes 'fullScreenPlayer'). */
const FULL_SCREEN_VARIANT = 'fullScreen';

/**
 * Warm the fullScreen cover variant for the next queue items while the
 * current song plays, through the SAME resolver pipeline the fullscreen
 * player uses — so opening the player or skipping a track paints from Dexie
 * instead of a multi-second server round-trip. Mirrors the upcoming-lyrics
 * prefetch (same subscription shape) and the trackmap deferral (never
 * competes with playback startup: waits until sound is audibly flowing).
 */
export const usePrefetchUpcomingCovers = (): void => {
    const inflightRef = useRef<Set<string>>(new Set());
    const prefetchedRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        let cancelled = false;
        const generation = new AbortController();

        const prefetch = async () => {
            const state = usePlayerStoreBase.getState();
            const items = state.getQueue().items;
            const index = state.player.index;
            if (index < 0 || index >= items.length) return;
            const current = items[index];
            const upcoming = items.slice(index + 1, index + 1 + PREFETCH_COUNT);
            if (upcoming.length === 0) return;

            try {
                await waitForPlaybackFlowing({
                    maxWaitMs: 8000,
                    signal: generation.signal,
                    songId: current?.id ?? '',
                });
            } catch {
                return; // aborted — a newer generation took over
            }
            if (cancelled || !getIsOnline()) return;

            let started = 0;
            for (const song of upcoming) {
                const imageId = song?.imageId;
                if (!imageId || !song._serverId) continue;
                const key = `${song._serverId}:${imageId}`;
                if (inflightRef.current.has(key) || prefetchedRef.current.has(key)) continue;

                const request = getItemImageRequest({
                    id: imageId,
                    itemType: LibraryItem.SONG,
                    serverId: song._serverId,
                    type: 'fullScreenPlayer',
                });
                if (!request) continue;

                inflightRef.current.add(key);
                started += 1;
                resolveThumbnail(imageId, FULL_SCREEN_VARIANT, request, {
                    // Warm Dexie only — no object URL to leak.
                    _skipBlobUrl: true,
                })
                    .catch(() => {
                        // Best-effort: the on-demand path retries when the
                        // fullscreen player actually asks for it.
                    })
                    .finally(() => {
                        inflightRef.current.delete(key);
                        prefetchedRef.current.add(key);
                        if (prefetchedRef.current.size > PREFETCHED_RECALL_LIMIT) {
                            const oldest = prefetchedRef.current.values().next();
                            if (!oldest.done) prefetchedRef.current.delete(oldest.value);
                        }
                    });
            }
            if (started > 0) {
                console.info('[image-variants] prefetch upcoming covers', {
                    count: started,
                    variant: FULL_SCREEN_VARIANT,
                });
            }
        };

        void prefetch();

        const unsubscribe = usePlayerStoreBase.subscribe(
            (state) => {
                const items = state.getQueue().items;
                return {
                    currentUniqueId: items[state.player.index]?._uniqueId,
                    queueLength: items.length,
                };
            },
            () => {
                void prefetch();
            },
            {
                equalityFn: (a, b) =>
                    a.currentUniqueId === b.currentUniqueId && a.queueLength === b.queueLength,
            },
        );

        return () => {
            cancelled = true;
            generation.abort();
            unsubscribe();
        };
    }, []);
};

export const UpcomingCoversPrefetch = (): null => {
    usePrefetchUpcomingCovers();
    return null;
};
