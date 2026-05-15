import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './new-since-last-visit.module.css';

import { api } from '/@/renderer/api';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Album, AlbumListSort, SortOrder } from '/@/shared/types/domain-types';

const STORAGE_KEY = 'home_last_visit_iso';
const MAX_LOOKBACK_DAYS = 14;
const PROBE_LIMIT = 60;

/**
 * Read the persisted last-visit ISO date string. Returns a fallback of
 * (now - {@link MAX_LOOKBACK_DAYS} days) when the user has never been here
 * before, so the widget always has *something* to surface on first run.
 */
const readLastVisit = (): Date => {
    const stored = localStorage.getItem(STORAGE_KEY);
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
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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

    // useRef's argument is only used on the first render but is re-evaluated on
    // every render in React 18, which would re-read localStorage each time. Use
    // lazy-init via useState for a clean read-once.
    const [lastVisit] = useState<Date>(() => readLastVisit());
    const [ready, setReady] = useState(false);

    useEffect(() => {
        // Persist the new "last visit" once we've snapshot the previous one.
        localStorage.setItem(STORAGE_KEY, new Date().toISOString());
        setReady(true);
    }, []);

    const { data: probe } = useQuery({
        enabled: Boolean(server?.id) && ready,
        queryFn: async ({ signal }) => {
            if (!server?.id) return [] as Album[];
            const res = await api.controller.getAlbumList({
                apiClientProps: { serverId: server.id, signal },
                query: {
                    limit: PROBE_LIMIT,
                    sortBy: AlbumListSort.RECENTLY_ADDED,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            return (res?.items ?? []) as Album[];
        },
        queryKey: ['home-new-since-last-visit', server?.id ?? ''] as const,
        staleTime: 1000 * 60 * 5,
    });

    const newCount = useMemo(() => {
        if (!probe) return 0;
        const threshold = lastVisit.getTime();
        return probe.filter((a) => {
            if (!a.createdAt) return false;
            const ts = new Date(a.createdAt).getTime();
            return Number.isFinite(ts) && ts >= threshold;
        }).length;
    }, [probe, lastVisit]);

    if (!probe) return null;
    if (newCount === 0) return null;

    return (
        <div className={styles.banner}>
            <div className={styles.left}>
                <span className={styles.eyebrow}>{t('page.home.newSinceLastVisit_eyebrow')}</span>
                <span className={styles.title}>
                    {t('page.home.newSinceLastVisit_title', { count: newCount })}
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
