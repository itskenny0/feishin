import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    LUCKY_QUEUE_SIZE,
    offlineSongIdsForServer,
    pickRandomFromCache,
    pickRandomOfflineFromCache,
} from './feeling-lucky';
import styles from './feeling-lucky-button.module.css';

import { getActiveCacheDb } from '/@/renderer/cache/db';
import { useCacheStore } from '/@/renderer/cache/store';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useLongPress } from '/@/renderer/hooks/use-long-press';
import { useIsOnline } from '/@/renderer/lib/network-status';
import { queryClient } from '/@/renderer/lib/react-query';
import { useCurrentServer } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { toast } from '/@/shared/components/toast/toast';
import { Played, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

/**
 * Gesture model:
 *   - tap / left-click  → play a random pick from the LOCAL CACHE (instant,
 *     offline). Falls back to the remote fetch if the cache is unavailable or
 *     empty.
 *   - long-press (touch) / right-click → fetch a FRESH random set from the
 *     server.
 *
 * `onClick` is the single entry point for the cache path: it fires for a mouse
 * left-click and for the synthetic click a touch tap produces. useLongPress
 * swallows the synthetic click after a long-press (via onClickCapture), so a
 * long-press never also triggers the cache path.
 *
 * Two-stage remote fetch: a small first batch starts playback as fast as the
 * server can return it; the larger tail fills the queue in the background.
 *
 * OFFLINE behaviour: when the combined connectivity signal is offline, every
 * gesture (tap, long-press, right-click) draws ONLY from the downloaded-offline
 * pool — no network endpoint is touched. If nothing is downloaded for the
 * current server the button hides entirely (it reappears once back online).
 */
const FIRST_BATCH_LIMIT = 20;
const TAIL_BATCH_LIMIT = 80;

export const FeelingLuckyButton = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const online = useIsOnline();
    const { addToQueueByData } = usePlayer();
    const [loading, setLoading] = useState(false);
    // Guard against overlapping runs (double-tap, or a long-press plus the
    // Android WebView's own contextmenu both firing the remote path).
    const inFlightRef = useRef(false);

    // How many of this server's songs are downloaded offline. Read from the
    // in-memory availability snapshot (no Dexie). Drives both the offline pick
    // pool and the "hide when offline + empty" rule.
    const offlineCount = useCacheStore((s) => {
        if (!server?.id) return 0;
        let count = 0;
        const prefix = `${server.id}:`;
        for (const key of s.offlineAvailability.songKeys) {
            if (key.startsWith(prefix)) count += 1;
        }
        return count;
    });

    const fetchRemote = useCallback(async () => {
        const serverId = server?.id;
        if (!serverId) return;
        const baseQuery = { limit: FIRST_BATCH_LIMIT, played: Played.All };

        const tailPromise = queryClient
            .fetchQuery(
                songsQueries.random({
                    query: { ...baseQuery, limit: TAIL_BATCH_LIMIT },
                    serverId,
                }),
            )
            .catch((err) => {
                console.warn('[feeling-lucky] tail fetch failed', err);
                return null;
            });

        const first = await queryClient.fetchQuery(
            songsQueries.random({ query: baseQuery, serverId }),
        );
        const firstItems = (first?.items ?? []) as Song[];
        if (firstItems.length === 0) {
            toast.warn({ message: t('page.home.feelingLucky_error') });
            return;
        }
        console.info('[feeling-lucky] remote pick', firstItems.length, 'tracks');
        addToQueueByData(firstItems, Play.NOW);

        const seenIds = new Set(firstItems.map((s) => s.id));
        const tail = await tailPromise;
        const tailItems = ((tail?.items ?? []) as Song[]).filter((s) => !seenIds.has(s.id));
        if (tailItems.length > 0) {
            addToQueueByData(tailItems, Play.LAST);
        }
    }, [addToQueueByData, server?.id, t]);

    // Offline pick: random songs drawn ONLY from the downloaded pool. Never
    // touches the network — used for every gesture while offline.
    const pickFromOffline = useCallback(async () => {
        const serverId = server?.id;
        const db =
            useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;
        if (!serverId || !db) {
            console.info('[offline-ux] lucky: offline but cache unavailable', {
                offline: true,
                poolSize: 0,
            });
            toast.warn({ message: t('error.offlineNotAvailable') });
            return;
        }
        const offlineIds = offlineSongIdsForServer(
            useCacheStore.getState().offlineAvailability.songKeys,
            serverId,
        );
        const songs = await pickRandomOfflineFromCache(db, offlineIds, LUCKY_QUEUE_SIZE);
        console.info('[offline-ux] lucky: offline pool pick', {
            offline: true,
            poolSize: songs.length,
        });
        if (songs.length === 0) {
            toast.warn({ message: t('error.offlineNotAvailable') });
            return;
        }
        addToQueueByData(songs, Play.NOW);
    }, [addToQueueByData, server?.id, t]);

    // Local-cache pick (tap / left-click) for the ONLINE path. Falls back to
    // remote on miss.
    const pickFromCache = useCallback(async () => {
        const db =
            useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;
        if (!db) {
            console.info('[offline-ux] lucky: online cache unavailable — remote', {
                offline: false,
                poolSize: 0,
            });
            await fetchRemote();
            return;
        }
        const songs = await pickRandomFromCache(db, LUCKY_QUEUE_SIZE);
        if (songs.length === 0) {
            console.info('[offline-ux] lucky: online cache empty — remote', {
                offline: false,
                poolSize: 0,
            });
            await fetchRemote();
            return;
        }
        console.info('[offline-ux] lucky: online cache pick', {
            offline: false,
            poolSize: songs.length,
        });
        addToQueueByData(songs, Play.NOW);
    }, [addToQueueByData, fetchRemote]);

    // Single lifecycle owner: the guard, the loading flag, and the error toast
    // live here so cache/remote paths can't overlap and always reset.
    const run = useCallback(
        async (work: () => Promise<void>) => {
            if (inFlightRef.current || !server?.id) return;
            inFlightRef.current = true;
            setLoading(true);
            try {
                await work();
            } catch (err) {
                console.warn('[feeling-lucky] failed', err);
                toast.error({ message: t('page.home.feelingLucky_error') });
            } finally {
                setLoading(false);
                inFlightRef.current = false;
            }
        },
        [server?.id, t],
    );

    // Tap / left-click. Offline → offline pool only; online → cache-then-remote.
    const playPrimary = useCallback(() => {
        void run(online ? pickFromCache : pickFromOffline);
    }, [run, online, pickFromCache, pickFromOffline]);
    // Long-press / right-click. Offline → offline pool (no network); online →
    // fresh remote set.
    const playSecondary = useCallback(() => {
        void run(online ? fetchRemote : pickFromOffline);
    }, [run, online, fetchRemote, pickFromOffline]);

    const longPressHandlers = useLongPress({ onLongPress: playSecondary });

    // Offline with nothing downloaded for this server: hide the button. It
    // reappears automatically once back online (useIsOnline re-renders).
    const hidden = useMemo(() => !online && offlineCount === 0, [online, offlineCount]);
    if (hidden) {
        return null;
    }

    return (
        <button
            aria-busy={loading}
            aria-label={t('page.home.feelingLucky_tooltip')}
            className={`${styles.luckyButton}${loading ? ` ${styles.loading}` : ''}`}
            disabled={loading}
            onClick={playPrimary}
            onContextMenu={(event) => {
                event.preventDefault();
                playSecondary();
            }}
            type="button"
            {...longPressHandlers}
        >
            <span className={styles.luckyIcon}>
                <Icon icon={loading ? 'spinner' : 'sparkles'} size="md" />
            </span>
            <span>
                {loading ? t('page.home.feelingLucky_loading') : t('page.home.feelingLucky')}
            </span>
        </button>
    );
};
