import { useEffect, useRef } from 'react';

import { preloadThumbnailUrls, resolveThumbnail } from '/@/renderer/cache';
import { getItemImageRequest } from '/@/renderer/components/item-image/item-image';
import { waitForPlaybackFlowing } from '/@/renderer/features/trackmap/analysis/defer-until-playing';
import { getIsOnline } from '/@/renderer/lib/network-status';
import {
    isShuffleEnabled,
    mapShuffledToQueueIndex,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

/** How many upcoming queue items get their cover warmed. */
const PREFETCH_COUNT = 2;
/** fullScreen covers are a few hundred KB — bound the recall set anyway. */
const PREFETCHED_RECALL_LIMIT = 300;
/** The variant the fullscreen player resolves (imageRes 'fullScreenPlayer'). */
const FULL_SCREEN_VARIANT = 'fullScreen';

/**
 * The minimal slice of the player store this prefetch reads. Kept structural so
 * the derivation stays testable without standing up the whole store.
 */
type NeighborState = {
    getQueue: () => { items: QueueSong[] };
    player: { index: number; repeat: PlayerRepeat; shuffle: PlayerShuffle };
    queue: { default: string[]; shuffled: number[] };
};

/**
 * The songs the fullscreen player can paint from the CURRENT playback position:
 * the current track, the one it swipes/crossfades BACK to (previous), and the
 * next few it advances to (upcoming) — all in true PLAYBACK order.
 *
 * `player.index` is the playback position; under shuffle it indexes
 * `queue.shuffled` (an array of indices into the default/display queue), NOT the
 * default order that `getQueue().items` returns. Deriving neighbors off the raw
 * default order (as this hook used to) warms the wrong tracks whenever shuffle
 * is on. This mirrors the store's own `getCurrentSong` / `getPlayerData`
 * shuffle+repeat mapping so we warm exactly what the player will show.
 */
const collectNeighborSongs = (
    state: NeighborState,
    upcomingCount: number,
): { current: QueueSong | undefined; previous: QueueSong | undefined; upcoming: QueueSong[] } => {
    const items = state.getQueue().items; // default (display) order
    const shuffle = isShuffleEnabled(state);
    const repeat = state.player.repeat;
    // Playback axis: shuffled positions under shuffle, else the default order.
    const axisLength = shuffle ? state.queue.shuffled.length : items.length;
    if (axisLength === 0) return { current: undefined, previous: undefined, upcoming: [] };

    // Resolve a playback position → the QueueSong actually played there.
    // Out-of-range slots wrap only under repeat-all, matching `getPlayerData`.
    const songAt = (playbackPos: number): QueueSong | undefined => {
        let pos = playbackPos;
        if (pos < 0 || pos >= axisLength) {
            if (repeat !== PlayerRepeat.ALL) return undefined;
            pos = ((pos % axisLength) + axisLength) % axisLength;
        }
        const queueIndex = shuffle ? mapShuffledToQueueIndex(pos, state.queue.shuffled) : pos;
        return items[queueIndex];
    };

    const playbackIndex = state.player.index;
    const upcoming: QueueSong[] = [];
    for (let i = 1; i <= upcomingCount; i += 1) {
        const song = songAt(playbackIndex + i);
        if (song) upcoming.push(song);
    }
    return {
        current: songAt(playbackIndex),
        previous: songAt(playbackIndex - 1),
        upcoming,
    };
};

/**
 * Warm the fullScreen cover variant for the neighbouring queue items while the
 * current song plays, through the SAME resolver pipeline the fullscreen
 * player uses — so opening the player or skipping a track paints from Dexie
 * instead of a multi-second server round-trip. Mirrors the upcoming-lyrics
 * prefetch (same subscription shape) and the trackmap deferral (never
 * competes with playback startup: waits until sound is audibly flowing).
 *
 * "Neighbouring" means the actual PLAYBACK neighbours — shuffle- and
 * repeat-aware — and includes the previous slot (the fullscreen art has a
 * previousSong crossfade/swipe-back slot; repeat-all wraps it) so skipping in
 * either direction paints instantly.
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
            const { current, previous, upcoming } = collectNeighborSongs(state, PREFETCH_COUNT);
            if (!current && !previous && upcoming.length === 0) return;

            // Prime the CURRENT (+ previous + upcoming) covers into the
            // IN-MEMORY shared URL cache IMMEDIATELY — before the
            // playback-flowing wait — keyed by albumId, the SAME key the
            // fullscreen player art resolves against. This is what lets the
            // fullscreen cover paint synchronously on its first render via the
            // cross-variant peek (instead of an async Dexie hop + crossfade
            // adoption): itemCard is always swept, and fullScreen lands here
            // once it's been prefetched below, so the seed serves the best
            // variant already in memory. Zero-ref + grace-windowed, so this
            // can't pin blob memory.
            const memIds = [current, previous, ...upcoming]
                .map((song) => song?.albumId ?? song?.imageId)
                .filter((id): id is string => Boolean(id));
            if (memIds.length > 0) {
                // `table` (the player-bar / miniplayer cover), `itemCard` (the
                // fullscreen cross-variant seed + cards), and `fullScreen` (the
                // hi-res now-playing art). Priming all three keyed by albumId
                // means every now-playing cover surface peeks a hit instead of
                // racing an async resolve at play-start.
                void preloadThumbnailUrls(memIds, 'table');
                void preloadThumbnailUrls(memIds, 'itemCard');
                void preloadThumbnailUrls(memIds, FULL_SCREEN_VARIANT);
            }

            // Network-warm the fullScreen variant (the expensive, un-swept
            // bucket) for the slots the fullscreen player can swipe/crossfade
            // to: the previous track and the next few. The current track is
            // resolved on demand when the player opens.
            const warmTargets = previous ? [previous, ...upcoming] : upcoming;
            if (warmTargets.length === 0) return;

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
            for (const song of warmTargets) {
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
                // Track the ACTUAL playback-order current song (shuffle-aware),
                // so the prefetch re-runs when the real now-playing track
                // changes — not when the default-order slot at `player.index`
                // does (which is a different, wrong track under shuffle).
                const queueIndex = isShuffleEnabled(state)
                    ? mapShuffledToQueueIndex(state.player.index, state.queue.shuffled)
                    : state.player.index;
                return {
                    currentUniqueId: state.queue.default[queueIndex],
                    queueLength: state.queue.default.length,
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
