import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LUCKY_QUEUE_SIZE, pickRandomFromCache } from './feeling-lucky';
import styles from './feeling-lucky-button.module.css';

import { getActiveCacheDb } from '/@/renderer/cache/db';
import { useCacheStore } from '/@/renderer/cache/store';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useLongPress } from '/@/renderer/hooks/use-long-press';
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
 */
const FIRST_BATCH_LIMIT = 20;
const TAIL_BATCH_LIMIT = 80;

export const FeelingLuckyButton = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const { addToQueueByData } = usePlayer();
    const [loading, setLoading] = useState(false);
    // Guard against overlapping runs (double-tap, or a long-press plus the
    // Android WebView's own contextmenu both firing the remote path).
    const inFlightRef = useRef(false);

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

    // Local-cache pick (tap / left-click). Falls back to remote on miss.
    const pickFromCache = useCallback(async () => {
        const db =
            useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;
        if (!db) {
            console.info('[feeling-lucky] cache unavailable — falling back to remote');
            await fetchRemote();
            return;
        }
        const songs = await pickRandomFromCache(db, LUCKY_QUEUE_SIZE);
        if (songs.length === 0) {
            console.info('[feeling-lucky] cache empty — falling back to remote');
            await fetchRemote();
            return;
        }
        console.info('[feeling-lucky] cache pick', songs.length, 'tracks');
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

    const playCache = useCallback(() => {
        void run(pickFromCache);
    }, [run, pickFromCache]);
    const playRemote = useCallback(() => {
        void run(fetchRemote);
    }, [run, fetchRemote]);

    const longPressHandlers = useLongPress({ onLongPress: playRemote });

    return (
        <button
            aria-busy={loading}
            aria-label={t('page.home.feelingLucky_tooltip')}
            className={`${styles.luckyButton}${loading ? ` ${styles.loading}` : ''}`}
            disabled={loading}
            onClick={playCache}
            onContextMenu={(event) => {
                event.preventDefault();
                playRemote();
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
