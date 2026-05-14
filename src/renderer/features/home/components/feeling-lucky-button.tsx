import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './feeling-lucky-button.module.css';

import { api } from '/@/renderer/api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useCurrentServer } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { toast } from '/@/shared/components/toast/toast';
import { Played, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

/**
 * Two-stage random fetch so playback starts as fast as the server can return
 * a small first batch — the larger second batch fills the queue in the
 * background. Different random calls return different songs on every server
 * we support, so we still dedupe by id when appending.
 */
const FIRST_BATCH_LIMIT = 20;
const TAIL_BATCH_LIMIT = 80;

export const FeelingLuckyButton = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const { addToQueueByData } = usePlayer();
    const [loading, setLoading] = useState(false);
    // Guard against double-clicks: the second click would race the first and
    // produce a confusing queue of mixed sets.
    const inFlightRef = useRef(false);

    const handleClick = useCallback(async () => {
        if (inFlightRef.current || !server?.id) return;
        inFlightRef.current = true;
        setLoading(true);

        const baseQuery = {
            limit: FIRST_BATCH_LIMIT,
            played: Played.All,
        };

        // Kick off the tail fetch in parallel; it can resolve after we've
        // already started playback.
        const tailPromise = api.controller
            .getRandomSongList({
                apiClientProps: { serverId: server.id },
                query: { ...baseQuery, limit: TAIL_BATCH_LIMIT },
            })
            .catch((err) => {
                console.warn('[feeling-lucky] tail fetch failed', err);
                return null;
            });

        try {
            const first = await api.controller.getRandomSongList({
                apiClientProps: { serverId: server.id },
                query: baseQuery,
            });

            const firstItems = (first?.items ?? []) as Song[];
            if (firstItems.length === 0) {
                toast.warn({ message: t('page.home.feelingLucky_error') });
                return;
            }

            // Start playback immediately — the local Player.NOW path resets the
            // queue to these N tracks and starts playing.
            addToQueueByData(firstItems, Play.NOW);

            // Then drop the tail in behind. dedupe in case the server happened
            // to return the same id twice across the two random calls.
            const seenIds = new Set(firstItems.map((s) => s.id));
            const tail = await tailPromise;
            const tailItems = ((tail?.items ?? []) as Song[]).filter((s) => !seenIds.has(s.id));
            if (tailItems.length > 0) {
                addToQueueByData(tailItems, Play.LAST);
            }
        } catch (err) {
            console.warn('[feeling-lucky] first fetch failed', err);
            toast.error({ message: t('page.home.feelingLucky_error') });
        } finally {
            setLoading(false);
            inFlightRef.current = false;
        }
    }, [addToQueueByData, server?.id, t]);

    return (
        <button
            aria-busy={loading}
            aria-label={t('page.home.feelingLucky_tooltip')}
            className={`${styles.luckyButton}${loading ? ` ${styles.loading}` : ''}`}
            disabled={loading}
            onClick={handleClick}
            type="button"
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
