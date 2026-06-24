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
        // One controller per prefetch() invocation: a song change aborts the
        // previous wait instead of letting it ride waitForPlaybackFlowing's
        // cap (a stale song's wait can never resolve by condition, and each
        // pending wait holds two store subscriptions — rapid skipping piled
        // them up; review matrix, 2026-06-11).
        let inflightWait: AbortController | null = null;

        const prefetch = async () => {
            const state = usePlayerStoreBase.getState();
            const items = state.getQueue().items;
            const index = state.player.index;
            if (index < 0 || index >= items.length) return;
            const current = items[index];
            const upcoming = items.slice(index + 1, index + 1 + PREFETCH_COUNT);
            if (upcoming.length === 0) return;

            inflightWait?.abort();
            const myWait = new AbortController();
            inflightWait = myWait;
            try {
                await waitForPlaybackFlowing({
                    maxWaitMs: 8000,
                    signal: myWait.signal,
                    songId: current?.id ?? '',
                });
            } catch {
                return; // aborted — a newer prefetch took over (or unmount)
            }
            if (cancelled || !getIsOnline()) return;

            let started = 0;
            for (const song of upcoming) {
                const imageId = song?.albumId ?? song?.imageId ?? undefined;
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
                    .then(() => {
                        // Mark done only on SUCCESS — a transient failure
                        // must stay eligible for re-warming on the next
                        // queue change (the resolver itself negative-caches
                        // authoritative 404s, so no-artwork items don't
                        // retry-spam through this path either).
                        prefetchedRef.current.add(key);
                        if (prefetchedRef.current.size > PREFETCHED_RECALL_LIMIT) {
                            const oldest = prefetchedRef.current.values().next();
                            if (!oldest.done) prefetchedRef.current.delete(oldest.value);
                        }
                    })
                    .catch(() => {
                        // Best-effort: the on-demand path retries when the
                        // fullscreen player actually asks for it.
                    })
                    .finally(() => {
                        inflightRef.current.delete(key);
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
            inflightWait?.abort();
            unsubscribe();
        };
    }, []);
};

export const UpcomingCoversPrefetch = (): null => {
    usePrefetchUpcomingCovers();
    return null;
};
