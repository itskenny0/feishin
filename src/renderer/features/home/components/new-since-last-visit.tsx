import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './new-since-last-visit.module.css';

import { api } from '/@/renderer/api';
import {
    getActiveCacheDb,
    isCacheAvailableSync,
    readSnapshot,
    toCachedAlbumRow,
    writeSnapshot,
} from '/@/renderer/cache';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Album, AlbumListSort, SortOrder } from '/@/shared/types/domain-types';

// Stored per-server so switching servers doesn't carry one library's last-visit
// across to another. Older single-key value is gracefully ignored.
const STORAGE_KEY_PREFIX = 'home_last_visit_iso:';
const MAX_LOOKBACK_DAYS = 14;
// Cap how far back we'll look on first run / for the fallback. Keep this in
// sync with MAX_LOOKBACK_DAYS so first-visit and returning-user lookback
// windows match.
const FALLBACK_LOOKBACK_DAYS = MAX_LOOKBACK_DAYS;
// Sized to cover ~14 days on most libraries. If the actual count is larger
// (it can happen on heavily-curated libraries) the banner switches to "60+".
const PROBE_LIMIT = 200;

const storageKey = (serverId: string) => `${STORAGE_KEY_PREFIX}${serverId}`;

/**
 * Read the persisted last-visit ISO date string for this server. Returns a
 * fallback of (now - {@link FALLBACK_LOOKBACK_DAYS} days) when the user has
 * never been here before, so the widget has something to surface on first run.
 */
const readLastVisit = (serverId: string): Date => {
    const stored = localStorage.getItem(storageKey(serverId));
    if (stored) {
        const parsed = new Date(stored);
        if (!Number.isNaN(parsed.getTime())) {
            // Clamp to at most MAX_LOOKBACK_DAYS so a long absence doesn't
            // pull in hundreds of items.
            const cutoff = Date.now() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
            if (parsed.getTime() < cutoff) return new Date(cutoff);
            return parsed;
        }
    }
    return new Date(Date.now() - FALLBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
};

/**
 * Home-page widget surfacing how many albums have been added since the user's
 * previous visit. Clicking the button drops them on the regular Albums page
 * sorted by recently-added so they can browse from there. We don't try to
 * render the matching album tiles inline — the Recently Added carousel
 * already covers that use case, and a compact banner is more readable.
 */
export const NewSinceLastVisit = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const serverId = server?.id ?? '';

    // Snapshot of the previous-visit timestamp, captured once on mount per
    // server. Re-derive when the server changes so the banner shows the right
    // library's window. (Lazy useState initialiser so localStorage isn't read
    // on every render.)
    const [lastVisit, setLastVisit] = useState<Date>(() => readLastVisit(serverId));

    useEffect(() => {
        // Server changed (or first mount with a real server). Snapshot the
        // previous value for *this* server then DON'T immediately overwrite
        // it — the previous implementation wrote `now` on every mount, which
        // made the second open of the home page show ~0 new albums even
        // though plenty had arrived since the user's actual previous session.
        //
        // We instead persist `now` only on tab/window close. That way the
        // banner reflects "since the previous session" rather than "since
        // the previous home-page render".
        if (!serverId) return;
        setLastVisit(readLastVisit(serverId));

        const persistNow = () => {
            localStorage.setItem(storageKey(serverId), new Date().toISOString());
        };
        // Persist on actual app/tab close only. The previous version also
        // listened for visibilitychange:hidden, which in Electron fires on
        // every alt-tab and on Windows on every minimize → the timestamp
        // moved forward constantly and the banner effectively never showed.
        // The pagehide event fires on actual page navigation/close in both
        // browsers and Electron, covering the case where beforeunload is
        // suppressed (mobile browsers / strict-tab-close).
        window.addEventListener('beforeunload', persistNow);
        window.addEventListener('pagehide', persistNow);
        return () => {
            window.removeEventListener('beforeunload', persistNow);
            window.removeEventListener('pagehide', persistNow);
        };
    }, [serverId]);

    const { data: probe } = useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<Album[]>(['home-new-since-last-visit', serverId])) as never,
        queryFn: async ({ signal }) => {
            const key = ['home-new-since-last-visit', serverId] as const;
            if (!serverId) {
                const empty = [] as Album[];
                writeSnapshot(key, empty);
                return empty;
            }
            const res = await api.controller.getAlbumList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: PROBE_LIMIT,
                    sortBy: AlbumListSort.RECENTLY_ADDED,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            const result = (res?.items ?? []) as Album[];
            // Write-through into Dexie albums so subsequent grid/list mounts
            // hit cache even if the recently-added probe was the first
            // contact with these rows.
            if (isCacheAvailableSync() && result.length > 0) {
                try {
                    const db = getActiveCacheDb();
                    if (db) await db.albums.bulkPut(result.map(toCachedAlbumRow));
                } catch {
                    /* swallow */
                }
            }
            writeSnapshot(key, result);
            return result;
        },
        queryKey: ['home-new-since-last-visit', serverId] as const,
        staleTime: 1000 * 60 * 5,
    });

    const { atCap, newCount } = useMemo(() => {
        if (!probe) return { atCap: false, newCount: 0 };
        const threshold = lastVisit.getTime();
        let count = 0;
        for (const a of probe) {
            if (!a.createdAt) continue;
            const ts = new Date(a.createdAt).getTime();
            if (Number.isFinite(ts) && ts >= threshold) count += 1;
        }
        // If the probe is the full PROBE_LIMIT AND every entry is newer than
        // the threshold, the true count may exceed our sample — flag so the
        // copy can show "PROBE_LIMIT+" instead of a misleading exact number.
        const saturated = probe.length === PROBE_LIMIT && count === PROBE_LIMIT;
        return { atCap: saturated, newCount: count };
    }, [probe, lastVisit]);

    if (!probe) return null;
    if (newCount === 0) return null;

    return (
        <div className={styles.banner}>
            <div className={styles.left}>
                <span className={styles.eyebrow}>{t('page.home.newSinceLastVisit_eyebrow')}</span>
                <span className={styles.title}>
                    {atCap
                        ? t('page.home.newSinceLastVisit_title', {
                              count: newCount,
                              defaultValue: `{{count}}+ new since last visit`,
                          })
                        : t('page.home.newSinceLastVisit_title', { count: newCount })}
                </span>
                <span className={styles.subtitle}>
                    {t('page.home.newSinceLastVisit_subtitle', {
                        date: lastVisit.toLocaleDateString(),
                    })}
                </span>
            </div>
            <Link className={styles.action} to={AppRoute.LIBRARY_ALBUMS}>
                <Icon icon="arrowRight" />
                {t('page.home.newSinceLastVisit_browse')}
            </Link>
        </div>
    );
};
