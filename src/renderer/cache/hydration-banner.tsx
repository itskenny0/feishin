import { Alert, Button, Group } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getActiveCacheDb, hydrate, useCacheStore } from '/@/renderer/cache';
import { useAuthStore, useSettingsStore } from '/@/renderer/store';

const DISMISS_KEY_PREFIX = 'feishin:hydration-banner-dismissed:';

const readDismissed = (serverId: string): boolean => {
    if (typeof sessionStorage === 'undefined') return false;
    try {
        return sessionStorage.getItem(DISMISS_KEY_PREFIX + serverId) === '1';
    } catch {
        return false;
    }
};

const writeDismissed = (serverId: string): void => {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.setItem(DISMISS_KEY_PREFIX + serverId, '1');
    } catch {
        // Storage may be unavailable (private mode, quota); the dismissal
        // still lives in component state for the rest of this mount.
    }
};

export const HydrationBanner = () => {
    const { t } = useTranslation();
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const server = useAuthStore((s) => s.currentServer);
    const cacheAvailable = useCacheStore((s) => s.cacheAvailable);
    // Re-evaluate the banner once the active DB handle resolves. Without
    // this dep, a race between the capability probe (flips cacheAvailable
    // true) and the DB open (sets activeServer) leaves the banner stuck
    // hidden because getActiveCacheDb() reads undefined.
    const activeServer = useCacheStore((s) => s.activeServer);

    const [dismissed, setDismissed] = useState<boolean>(() =>
        server ? readDismissed(server.id) : false,
    );
    const [shouldShow, setShouldShow] = useState<boolean>(false);

    // Re-seed the dismissed flag whenever the active server changes so that
    // switching to a different server (which may have its own dismissal
    // state) reflects the right banner visibility.
    useEffect(() => {
        if (!server) {
            setDismissed(false);
            return;
        }
        setDismissed(readDismissed(server.id));
    }, [server]);

    useEffect(() => {
        let cancelled = false;

        const evaluate = async () => {
            if (!server || server.type !== 'jellyfin') {
                if (!cancelled) setShouldShow(false);
                return;
            }
            if (cacheAvailable === false) {
                if (!cancelled) setShouldShow(false);
                return;
            }
            if (dismissed) {
                if (!cancelled) setShouldShow(false);
                return;
            }
            const db = getActiveCacheDb();
            if (!db) {
                if (!cancelled) setShouldShow(false);
                return;
            }
            try {
                const rows = await db.syncMeta
                    .where('EntityType')
                    .anyOf('artists', 'albums', 'genres', 'playlists', 'favorites')
                    .toArray();
                if (cancelled) return;
                const fresh = rows.length === 0 || rows.every((r) => r.hydrationState === 'none');
                setShouldShow(fresh);
            } catch (err) {
                console.warn('[cache] hydration-banner: db read failed', err);
                if (!cancelled) setShouldShow(false);
            }
        };

        void evaluate();

        return () => {
            cancelled = true;
        };
    }, [server, cacheAvailable, dismissed, activeServer]);

    if (!enabled) return null;
    if (!shouldShow || !server) return null;

    const handleAccept = () => {
        setDismissed(true);
        writeDismissed(server.id);
        // Best-effort request for persistent storage so the browser is less
        // likely to evict the cache DB under quota pressure. Guarded for
        // platforms (and Electron contexts) that don't expose the API.
        try {
            void navigator.storage?.persist?.();
        } catch {
            // ignore — persistence is non-essential.
        }
        console.info('[cache] hydration-banner: user accepted full sync');
        void hydrate(server, 'full');
    };

    const handleDecline = () => {
        setDismissed(true);
        writeDismissed(server.id);
        console.info('[cache] hydration-banner: user declined full sync, lazy mode set');
        void hydrate(server, 'lazy');
    };

    return (
        <Alert
            color="blue"
            title={t('page.setting.librarySyncBannerTitle', {
                defaultValue: 'Cache your library for instant browsing?',
            })}
        >
            <p style={{ margin: '0 0 0.75rem' }}>
                {t('page.setting.librarySyncBannerSubtitle', {
                    defaultValue:
                        "We'll fetch your library and keep it in sync in the background, so every screen renders instantly.",
                })}
            </p>
            <Group>
                <Button color="blue" onClick={handleAccept}>
                    {t('page.setting.librarySyncBannerYes', { defaultValue: 'Sync now' })}
                </Button>
                <Button onClick={handleDecline} variant="default">
                    {t('page.setting.librarySyncBannerNo', { defaultValue: 'Not now' })}
                </Button>
            </Group>
        </Alert>
    );
};
