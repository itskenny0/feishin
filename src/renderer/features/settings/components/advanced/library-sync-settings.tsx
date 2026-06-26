import type { EntityType } from '/@/renderer/cache/types';
import type { ServerListItem } from '/@/shared/types/domain-types';

import { Capacitor } from '@capacitor/core';
import { Alert, Button, Group, Progress, Slider, Stack, Switch, Text, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import packageJson from '../../../../../../package.json';

import {
    clearLastOpenError,
    formatBytes as formatBytesSI,
    formatCount,
    getActiveCacheDb,
    getLastOpenError,
    hydrate,
    openCacheDb,
    resetCacheDb,
    useCacheStore,
    usePlatformCacheCapability,
    useSmoothSweep,
} from '/@/renderer/cache';
import {
    cachedBytes,
    clearAllCacheData,
    clearThumbnails,
    estimateBytes,
    getCurrentCapBytes,
    isQuotaCapped,
} from '/@/renderer/cache/eviction';
import { cancelHydration } from '/@/renderer/cache/sync';
import { CacheStatsWidget } from '/@/renderer/features/settings/components/advanced/cache-stats-widget';
import { ConsoleLogViewer } from '/@/renderer/features/settings/components/advanced/console-log-viewer';
import { useAuthStore, useSettingsStore } from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SLIDER_MIN = 256 * MIB;
const SLIDER_MAX = 8 * GIB;
const SLIDER_STEP = 256 * MIB;

const ENTITY_LABEL_KEYS: Record<EntityType, string> = {
    albums: 'page.setting.librarySyncDashboard.entityAlbums',
    artists: 'page.setting.librarySyncDashboard.entityArtists',
    favorites: 'page.setting.librarySyncDashboard.entityFavorites',
    genres: 'page.setting.librarySyncDashboard.entityGenres',
    lyrics: 'page.setting.librarySyncDashboard.entityLyrics',
    playlists: 'page.setting.librarySyncDashboard.entityPlaylists',
    songs: 'page.setting.librarySyncDashboard.entitySongs',
    thumbnails: 'page.setting.librarySyncDashboard.entityThumbnails',
};

const ENTITY_DISPLAY_ORDER: EntityType[] = [
    'artists',
    'genres',
    'albums',
    'songs',
    'lyrics',
    'playlists',
    'favorites',
];

const formatRelative = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    if (diff < 0) return 'just now';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(timestamp).toLocaleDateString();
};

const formatBytes = (n: number | undefined): string => {
    if (n === undefined || !Number.isFinite(n)) return '—';
    if (n / GIB >= 1) return `${(n / GIB).toFixed(1)} GiB`;
    return `${Math.round(n / MIB)} MiB`;
};

const formatCap = (n: number | undefined): string => {
    if (n === undefined) return '—';
    if (!Number.isFinite(n)) return '∞';
    return formatBytes(n);
};

/*
 * Themed replacement for the old native `window.confirm()` guard. The
 * destructive cache actions are async, so we run their body inside the
 * modal's `onConfirm` callback rather than gating a synchronous early
 * return. `confirmLabel` defaults to the shared "Confirm" string.
 */
const confirmAction = (params: {
    cancelLabel: string;
    confirmLabel: string;
    message: string;
    onConfirm: () => void;
    title: string;
}): void => {
    openConfirmModal({
        centered: true,
        children: params.message,
        labels: { cancel: params.cancelLabel, confirm: params.confirmLabel },
        onConfirm: params.onConfirm,
        title: params.title,
    });
};

/**
 * Isolated live-progress subtree. This is the ONLY thing that subscribes to the
 * fast-ticking sweep state (~20×/sec), so the heavy parent settings page (variant
 * table, sliders, diagnostics) doesn't re-render on every tick — opening the page
 * during a sync no longer starves the sync workers.
 */
const SweepProgressBlock = () => {
    const { t } = useTranslation();
    const smoothSweep = useSmoothSweep();
    const syncActive = useCacheStore((s) => s.syncActive);

    const entity = smoothSweep.entity;
    const sweepProgress =
        entity && smoothSweep.total
            ? Math.min(100, (100 * smoothSweep.done) / smoothSweep.total)
            : 0;
    const itemsPerSecLabel = entity ? smoothSweep.itemsPerSec.toFixed(1) : '0';
    const sweepProgressLabel = entity
        ? `${formatCount(smoothSweep.done)}/${smoothSweep.total ? formatCount(smoothSweep.total) : '?'} · ${itemsPerSecLabel} items/sec`
        : '';
    // "downloaded" + "remaining" (not "downloaded / total") — the projected total
    // only counts bytes downloaded THIS run, which read as total cache size.
    const sweepBytesLabel = (() => {
        if (!entity) return '';
        const downloaded = formatBytesSI(smoothSweep.bytesDownloaded);
        const rate = `${formatBytesSI(smoothSweep.bytesPerSec)}/s`;
        const remaining =
            smoothSweep.estimatedTotalBytes !== undefined &&
            smoothSweep.estimatedTotalBytes > smoothSweep.bytesDownloaded
                ? formatBytesSI(smoothSweep.estimatedTotalBytes - smoothSweep.bytesDownloaded)
                : undefined;
        return remaining
            ? `${downloaded} downloaded · ~${remaining} remaining · ${rate}`
            : `${downloaded} downloaded · ${rate}`;
    })();

    return (
        <Stack gap="xs">
            {entity ? (
                <>
                    <Text>
                        {t('page.setting.librarySyncDashboard.statusSweeping', {
                            entity: t(ENTITY_LABEL_KEYS[entity]),
                        })}
                        {smoothSweep.pageIndex !== undefined && smoothSweep.pageTotal !== undefined
                            ? ` · page ${smoothSweep.pageIndex}/${smoothSweep.pageTotal}`
                            : ''}
                        {smoothSweep.phase === 'fetching'
                            ? ' · ' +
                              t('page.setting.librarySyncDashboard.statusFetchingPage', {
                                  defaultValue: 'fetching next page…',
                              })
                            : ''}
                    </Text>
                    <Progress value={sweepProgress} />
                    <Text c="dimmed" size="sm">
                        {sweepProgressLabel}
                    </Text>
                    <Text c="dimmed" size="sm">
                        {sweepBytesLabel}
                    </Text>
                </>
            ) : syncActive ? (
                // Between entity sweeps the per-entity sweep is momentarily
                // undefined; the overall hydration is still running, so show a
                // live "preparing" state instead of "Idle" (which read as stalled).
                <>
                    <Text>
                        {t('page.setting.librarySyncDashboard.statusPreparing', {
                            defaultValue: 'Syncing…',
                        })}
                    </Text>
                    <Progress animated value={100} />
                </>
            ) : (
                <Text>{t('page.setting.librarySyncDashboard.statusIdle')}</Text>
            )}
        </Stack>
    );
};

export const LibrarySyncSettings = () => {
    const { t } = useTranslation();
    const currentServer = useAuthStore((s) => s.currentServer);
    // PLATFORM capability, not the store's `cacheAvailable` (that flag is
    // forced false while the cache is disabled — gating on it hid the enable
    // toggle behind "unavailable on this platform" for every opted-out
    // install; Windows portable, 2026-06-10).
    const platformCapable = usePlatformCacheCapability();
    // Subscribe ONLY to the coarse sweep entity, not the whole `sweep` object
    // (the engine rewrites it ~20×/sec). The live per-tick progress lives in the
    // isolated <SweepProgressBlock/> so this heavy page re-renders only on entity
    // transitions — opening it no longer starves the running sync.
    const sweepEntity = useCacheStore((s) => s.sweep?.entity);
    const syncActive = useCacheStore((s) => s.syncActive);
    const entityCounts = useCacheStore((s) => s.entityCounts);
    const hydrationStates = useCacheStore((s) => s.hydrationStates);
    const pendingMutations = useCacheStore((s) => s.pendingMutations);
    const bytesUsed = useCacheStore((s) => s.bytesUsed);
    const activeServer = useCacheStore((s) => s.activeServer);
    const cacheActions = useCacheStore((s) => s.actions);
    const localCacheCap = useSettingsStore((s) => s.localCache?.capacityBytes);
    const setLocalCache = useSettingsStore((s) => s.actions.setLocalCache);
    const resyncOnStartup = useSettingsStore((s) => s.localCache?.resyncOnStartup ?? true);
    const thumbnailConcurrency = useSettingsStore((s) => s.localCache?.thumbnailConcurrency);

    const [thumbnailCount, setThumbnailCount] = useState<number | undefined>(undefined);
    const [thumbnailBytes, setThumbnailBytes] = useState<number | undefined>(undefined);
    const [capBytes, setCapBytes] = useState<number | undefined>(undefined);
    // Per-entity diagnostics from `db.syncMeta`. Keyed by entity name.
    const [syncMeta, setSyncMeta] = useState<
        Partial<
            Record<
                EntityType,
                {
                    lastFullSyncAt: number | undefined;
                    lastSweepAt: number | undefined;
                    totalCount: number | undefined;
                }
            >
        >
    >({});
    // Local slider state — mirrors the persisted setting but lets the user
    // drag freely before we commit. `undefined` while we're still resolving
    // the platform default.
    const [sliderValue, setSliderValue] = useState<number | undefined>(undefined);
    // Diagnostic surface: runtime + IndexedDB capability info.
    const diagnostics = useMemo(() => {
        const cap = Capacitor.getPlatform?.();
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a';
        const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
        return { online, platform: cap ?? 'web', userAgent: ua };
    }, []);

    const quotaCapped = useMemo(() => isQuotaCapped(), []);

    // Refresh thumbnail count + total byte size + per-entity sync metadata
    // on mount, on server switch, on sweep ENTITY transitions, and on a
    // 2-second interval while a sweep is active. Previously the effect
    // depended on the full `sweep` reference which mutated every 50ms
    // (the per-page setSweep throttle); each effect run started an
    // async Dexie read and was immediately cancelled by the next render,
    // so the dashboard's Storage used / Thumbnails bytes display never
    // moved past the post-clear zero state. Now the effect's identity
    // only changes on coarse transitions and a self-managed interval
    // drives the in-sweep refresh cadence. (`sweepEntity` is the narrow
    // store selector declared above.)
    useEffect(() => {
        let cancelled = false;
        const db = getActiveCacheDb();
        if (!db) {
            setThumbnailCount(undefined);
            setThumbnailBytes(undefined);
            setSyncMeta({});
            return () => {
                cancelled = true;
            };
        }
        const refresh = async (): Promise<void> => {
            try {
                // Cheap always: an indexed count + the tiny syncMeta table.
                const [count, metaRows] = await Promise.all([
                    db.thumbnails.count(),
                    db.syncMeta.toArray(),
                ]);
                if (cancelled) return;
                setThumbnailCount(count);
                // The byte totals require O(N) thumbnail-ByteSize scans
                // (cachedBytes + estimateBytes both walk ~50k rows). Running
                // them every 2s DURING a sweep serializes against the sweep's
                // own IndexedDB writes on the single worker and slows it to a
                // crawl (the lifecycle tick + eviction listener already gate
                // this same cost behind an active sweep). So skip them while
                // sweeping — Storage used / thumbnail bytes refresh the moment
                // the sweep ends (this effect re-runs on the sweepEntity→
                // undefined transition).
                if (!sweepEntity) {
                    const [bytes, totalUsed] = await Promise.all([cachedBytes(), estimateBytes()]);
                    if (cancelled) return;
                    setThumbnailBytes(bytes);
                    useCacheStore.getState().actions.setBytesUsed(totalUsed);
                }
                const meta: typeof syncMeta = {};
                for (const r of metaRows) {
                    meta[r.EntityType] = {
                        lastFullSyncAt: r.lastFullSyncAt,
                        lastSweepAt: r.lastSweepAt,
                        totalCount: r.totalCount,
                    };
                }
                setSyncMeta(meta);
            } catch (err) {
                console.warn('[cache] dashboard: diagnostics read failed', { err });
                if (!cancelled) {
                    setThumbnailCount(undefined);
                    setThumbnailBytes(undefined);
                }
            }
        };
        void refresh();
        const interval = sweepEntity ? setInterval(() => void refresh(), 2000) : undefined;
        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, [sweepEntity, activeServer]);

    // Resolve the effective cap (user override or platform default). Reruns
    // whenever the persisted cap changes so the readout updates immediately
    // after a slider commit.
    useEffect(() => {
        let cancelled = false;
        getCurrentCapBytes()
            .then((n) => {
                if (!cancelled) {
                    setCapBytes(n);
                    if (sliderValue === undefined) {
                        const initial =
                            typeof localCacheCap === 'number' && localCacheCap > 0
                                ? localCacheCap
                                : Number.isFinite(n)
                                  ? n
                                  : SLIDER_MAX;
                        setSliderValue(
                            Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(initial))),
                        );
                    }
                }
            })
            .catch(() => {
                if (!cancelled) setCapBytes(undefined);
            });
        return () => {
            cancelled = true;
        };
        // sliderValue intentionally excluded — we only seed it once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [localCacheCap]);

    const refreshBytesUsed = useCallback(async () => {
        try {
            const used = await estimateBytes();
            useCacheStore.getState().actions.setBytesUsed(used);
        } catch (err) {
            console.warn('[cache] dashboard: refreshBytesUsed failed', { err });
        }
    }, []);

    const handleSyncNow = useCallback(
        (server: ServerListItem) => {
            try {
                console.info('[cache] dashboard: hydrate(full) requested');
                void hydrate(server, 'full');
            } catch (err) {
                console.warn('[cache] dashboard: hydrate failed', { err });
                toast.error({ message: (err as Error).message ?? String(err) });
            }
        },
        // no deps — server arg passed in
        [],
    );

    const handlePause = useCallback(() => {
        try {
            console.info('[cache] dashboard: pause requested');
            cancelHydration();
        } catch (err) {
            console.warn('[cache] dashboard: pause failed', { err });
            toast.error({ message: (err as Error).message ?? String(err) });
        }
    }, []);

    const resetEntityCountsForClear = useCallback(() => {
        // clearAllCacheData() empties Dexie but doesn't touch the
        // in-memory cache store. Without this reset the dashboard
        // keeps showing the pre-clear counts (and the sweep prefetch
        // log misleads about what's actually in the table). Wipe both
        // counts and hydration states so the new hydration writes
        // clean numbers as it progresses.
        const entities = [
            'albums',
            'artists',
            'favorites',
            'genres',
            'lyrics',
            'playlists',
            'songs',
            'thumbnails',
        ] as const;
        for (const e of entities) {
            cacheActions.setEntityCount(e, 0);
            cacheActions.setHydrationState(e, 'none');
        }
        cacheActions.setBytesUsed(0);
    }, [cacheActions]);

    // Default Re-sync — keeps existing rows and uses delta-sync mode
    // (sort by RECENTLY_ADDED desc, stop once item dates fall below
    // `lastFullSyncAt`). Fast on subsequent runs because we only fetch
    // items added since the previous sync.
    const handleResync = useCallback(
        (server: ServerListItem) => {
            confirmAction({
                cancelLabel: t('common.cancel', { defaultValue: 'Cancel' }),
                confirmLabel: t('common.confirm', { defaultValue: 'Confirm' }),
                message: t('page.setting.librarySyncDashboard.confirmResync'),
                onConfirm: () => {
                    void (async () => {
                        try {
                            console.info('[cache] dashboard: re-sync confirmed (delta-eligible)');
                            void hydrate(server, 'full');
                            await refreshBytesUsed();
                        } catch (err) {
                            console.warn('[cache] dashboard: re-sync failed', { err });
                            toast.error({ message: (err as Error).message ?? String(err) });
                        }
                    })();
                },
                title: t('page.setting.librarySyncDashboard.resync', {
                    defaultValue: 'Re-sync library',
                }),
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [refreshBytesUsed],
    );

    // Force full re-sync — clears the local cache first so the next
    // hydration walks every page from start. Use when the user
    // suspects local rot (metadata edited on server, items deleted,
    // etc.) — delta-mode misses those changes by design.
    const handleForceFullResync = useCallback(
        (server: ServerListItem) => {
            confirmAction({
                cancelLabel: t('common.cancel', { defaultValue: 'Cancel' }),
                confirmLabel: t('page.setting.librarySyncDashboard.forceFullResync', {
                    defaultValue: 'Force full re-sync',
                }),
                message: t('page.setting.librarySyncDashboard.confirmForceFullResync', {
                    defaultValue:
                        'Force a full re-sync? This wipes the local cache and re-downloads everything (slow). Use the regular Re-sync button for new items only.',
                }),
                onConfirm: () => {
                    void (async () => {
                        try {
                            console.info('[cache] dashboard: force-full re-sync confirmed');
                            await clearAllCacheData();
                            resetEntityCountsForClear();
                            setThumbnailCount(0);
                            setThumbnailBytes(0);
                            setSyncMeta({});
                            void hydrate(server, 'full');
                            await refreshBytesUsed();
                        } catch (err) {
                            console.warn('[cache] dashboard: force-full re-sync failed', { err });
                            toast.error({ message: (err as Error).message ?? String(err) });
                        }
                    })();
                },
                title: t('page.setting.librarySyncDashboard.forceFullResync', {
                    defaultValue: 'Force full re-sync',
                }),
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [refreshBytesUsed, resetEntityCountsForClear],
    );

    const handleClearThumbnails = useCallback(async () => {
        try {
            console.info('[cache] dashboard: clear thumbnails requested');
            await clearThumbnails();
            const db = getActiveCacheDb();
            if (db) {
                const n = await db.thumbnails.count();
                setThumbnailCount(n);
            }
            await refreshBytesUsed();
        } catch (err) {
            console.warn('[cache] dashboard: clear thumbnails failed', { err });
            toast.error({ message: (err as Error).message ?? String(err) });
        }
    }, [refreshBytesUsed]);

    const handleClearAll = useCallback(() => {
        confirmAction({
            cancelLabel: t('common.cancel', { defaultValue: 'Cancel' }),
            confirmLabel: t('page.setting.librarySyncDashboard.clearAll', {
                defaultValue: 'Clear all',
            }),
            message: t('page.setting.librarySyncDashboard.confirmClearAll'),
            onConfirm: () => {
                void (async () => {
                    try {
                        console.info('[cache] dashboard: clear all confirmed');
                        await clearAllCacheData();
                        resetEntityCountsForClear();
                        setThumbnailCount(0);
                        setThumbnailBytes(0);
                        setSyncMeta({});
                        await refreshBytesUsed();
                    } catch (err) {
                        console.warn('[cache] dashboard: clear all failed', { err });
                        toast.error({ message: (err as Error).message ?? String(err) });
                    }
                })();
            },
            title: t('page.setting.librarySyncDashboard.clearAll', {
                defaultValue: 'Clear all cache data',
            }),
        });
    }, [refreshBytesUsed, resetEntityCountsForClear, t]);

    // Hard-reset path that bypasses the active-handle requirement.
    // Triggered when the lifecycle reports a schema upgrade / open
    // failure — in that state the normal Clear / Re-sync buttons can't
    // do anything because they need a live db handle.
    const openErr = getLastOpenError();
    const handleForceReset = useCallback(() => {
        confirmAction({
            cancelLabel: t('common.cancel', { defaultValue: 'Cancel' }),
            confirmLabel: t('page.setting.librarySyncDashboard.forceReset', {
                defaultValue: 'Reset database',
            }),
            message: t('page.setting.librarySyncDashboard.confirmForceReset', {
                defaultValue: 'Reset and rebuild the cache database from scratch?',
            }),
            onConfirm: () => {
                void (async () => {
                    const err = getLastOpenError();
                    const serverId = err?.serverId ?? currentServer?.id;
                    const userId = err?.userId ?? currentServer?.userId;
                    if (!serverId || !userId) {
                        toast.error({ message: 'No server selected.' });
                        return;
                    }
                    try {
                        console.info('[cache] dashboard: force-reset DB', { serverId, userId });
                        await resetCacheDb(serverId, userId);
                        clearLastOpenError();
                        resetEntityCountsForClear();
                        setThumbnailCount(0);
                        setThumbnailBytes(0);
                        setSyncMeta({});
                        const reopened = await openCacheDb(serverId, userId);
                        if (reopened && currentServer) {
                            void hydrate(currentServer, 'full');
                        }
                        toast.success({ message: 'Cache database reset.' });
                    } catch (e) {
                        console.warn('[cache] dashboard: force-reset failed', { err: e });
                        toast.error({ message: (e as Error).message ?? String(e) });
                    }
                })();
            },
            title: t('page.setting.librarySyncDashboard.forceReset', {
                defaultValue: 'Reset cache database',
            }),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentServer, resetEntityCountsForClear]);

    const handleSliderCommit = useCallback(
        (bytes: number) => {
            console.info('[cache] dashboard: storage cap set', { bytes });
            setLocalCache({ capacityBytes: bytes });
        },
        [setLocalCache],
    );

    // Defence in depth — the subpage manifest already gates on
    // `server?.type === 'jellyfin'`, but if a non-Jellyfin server is
    // somehow active we still want to render a clear notice.
    if (currentServer && currentServer.type !== 'jellyfin') {
        return (
            <Stack gap="md">
                <Title order={3}>{t('page.setting.librarySync')}</Title>
                <Alert color="yellow">
                    {t('page.setting.librarySyncDashboard.statusJellyfinOnly')}
                </Alert>
            </Stack>
        );
    }

    if (platformCapable === false) {
        return (
            <Stack gap="md">
                <Title order={3}>{t('page.setting.librarySync')}</Title>
                <Alert color="yellow">
                    {t('page.setting.librarySyncDashboard.statusUnavailable')}
                </Alert>
            </Stack>
        );
    }

    if (openErr) {
        return (
            <Stack gap="md">
                <Title order={3}>{t('page.setting.librarySync')}</Title>
                <Alert color="red" title="Cache database failed to open">
                    <Stack gap="xs">
                        <Text size="sm">
                            The local cache database failed to open or upgrade. The sweep, offline
                            reads, and the in-app reset buttons cannot work until the database is
                            rebuilt from scratch.
                        </Text>
                        <Text c="dimmed" size="xs">
                            {openErr.error.name}: {openErr.error.message}
                        </Text>
                        <Group>
                            <Button color="red" onClick={handleForceReset} variant="filled">
                                Reset cache database
                            </Button>
                        </Group>
                    </Stack>
                </Alert>
            </Stack>
        );
    }

    // Disable destructive actions (regenerate / clear cache) while any sync is
    // running. The live per-tick sweep progress is rendered by the isolated
    // <SweepProgressBlock/> so it doesn't re-render this heavy page.
    const sweeping = syncActive;

    return (
        <Stack gap="lg">
            {/* Header */}
            <Stack gap="xs">
                <Title order={3}>{t('page.setting.librarySync')}</Title>
                <Text c="dimmed">{t('page.setting.librarySyncDescription')}</Text>
            </Stack>

            {/* Status line — the local cache is mandatory now (the blocking
                first-sync gate + dashboard own the initial full sync), so this
                is a read-only "on — required" notice rather than an opt-out
                toggle. */}
            <Alert color="blue" variant="light">
                {t('page.setting.librarySyncDashboard.cacheRequiredStatus', {
                    defaultValue:
                        'Local cache is on and required — your library is kept on-device so the app loads instantly and works offline.',
                })}
            </Alert>

            {/* Background re-sync. There is intentionally NO per-entity opt-out
                — the whole library is always synced (local-first). The only
                switch is whether to auto re-check the server on startup. */}
            <Stack gap="xs">
                <Title order={6}>
                    {t('page.setting.librarySyncDashboard.backgroundSyncTitle', {
                        defaultValue: 'Background sync',
                    })}
                </Title>
                <Switch
                    checked={resyncOnStartup}
                    description={t('page.setting.librarySyncDashboard.resyncHint', {
                        defaultValue:
                            'Re-check the server for changes when the app starts so the local copy stays fresh. Everything is always synced — this only controls the automatic refresh.',
                    })}
                    label={t('page.setting.librarySyncDashboard.resyncLabel', {
                        defaultValue: 'Re-sync the library on startup',
                    })}
                    onChange={(e) => setLocalCache({ resyncOnStartup: e.currentTarget.checked })}
                />

                <Title mt="sm" order={6}>
                    {t('page.setting.librarySyncDashboard.thumbnailsTitle', {
                        defaultValue: 'Artwork pre-cache',
                    })}
                </Title>
                <Text c="dimmed" size="sm">
                    {t('page.setting.librarySyncDashboard.thumbnailsHint', {
                        defaultValue:
                            'Cover art is pre-cached during sync so grids render instantly. Choose which sizes to store and how fast to fetch them below.',
                    })}
                </Text>

                {/* Concurrency slider — how many thumbnail fetches to
                        run in parallel during the sweep. Higher saturates the
                        link faster but spams the server / WebView. */}
                <Stack gap={4} mt="sm">
                    <Group justify="space-between">
                        <Text size="sm">
                            {t('page.setting.librarySyncDashboard.thumbnailConcurrency', {
                                defaultValue: 'Parallel downloads',
                            })}
                        </Text>
                        <Text c="dimmed" size="sm">
                            {thumbnailConcurrency ?? 24}
                        </Text>
                    </Group>
                    <Slider
                        label={(value) => `${value}`}
                        max={64}
                        min={1}
                        onChangeEnd={(value) => setLocalCache({ thumbnailConcurrency: value })}
                        step={1}
                        value={thumbnailConcurrency ?? 24}
                    />
                    <Text c="dimmed" size="xs">
                        {t('page.setting.librarySyncDashboard.thumbnailConcurrencyHelp', {
                            defaultValue:
                                'Number of cover-art fetches the sweep runs in parallel. Raise it to saturate a fast LAN; lower it if the server gets unhappy.',
                        })}
                    </Text>
                </Stack>
            </Stack>

            {/* Status + current sweep — isolated so its 20fps updates don't
                re-render this whole page (which slowed the sync). */}
            <SweepProgressBlock />

            {/* Entity counts + per-entity diagnostics */}
            <Stack gap={4}>
                {ENTITY_DISPLAY_ORDER.map((entity) => {
                    const count = entityCounts[entity] ?? 0;
                    const state = hydrationStates[entity] ?? 'none';
                    const meta = syncMeta[entity];
                    const lastSyncAt = meta?.lastFullSyncAt ?? meta?.lastSweepAt;
                    return (
                        <Group align="flex-start" justify="space-between" key={entity}>
                            <Stack gap={0}>
                                <Text>{t(ENTITY_LABEL_KEYS[entity])}</Text>
                                {lastSyncAt && (
                                    <Text c="dimmed" size="xs">
                                        {t('page.setting.librarySyncDashboard.lastSynced', {
                                            defaultValue: 'last sync {{when}}',
                                            when: formatRelative(lastSyncAt),
                                        })}
                                    </Text>
                                )}
                            </Stack>
                            <Group gap="md">
                                <Text c="dimmed" size="sm">
                                    {count.toLocaleString()}
                                </Text>
                                <Text c="dimmed" size="sm">
                                    {state}
                                </Text>
                            </Group>
                        </Group>
                    );
                })}
                <Group justify="space-between">
                    <Stack gap={0}>
                        <Text>{t('page.setting.librarySyncDashboard.entityThumbnails')}</Text>
                        <Text c="dimmed" size="xs">
                            {thumbnailBytes !== undefined ? formatBytesSI(thumbnailBytes) : '—'}
                        </Text>
                    </Stack>
                    <Text c="dimmed" size="sm">
                        {thumbnailCount === undefined ? '—' : thumbnailCount.toLocaleString()}
                    </Text>
                </Group>
            </Stack>

            {/* Historical cache hit/miss stats */}
            <CacheStatsWidget />

            {/* Diagnostics + logs */}
            <Stack gap={4}>
                <Title order={6}>
                    {t('page.setting.librarySyncDashboard.diagnosticsTitle', {
                        defaultValue: 'Diagnostics',
                    })}
                </Title>
                <Group gap="md" justify="space-between">
                    <Text size="sm">
                        {t('page.setting.librarySyncDashboard.diagPlatform', {
                            defaultValue: 'Platform',
                        })}
                    </Text>
                    <Text c="dimmed" size="sm">
                        {diagnostics.platform}
                    </Text>
                </Group>
                <Group gap="md" justify="space-between">
                    <Text size="sm">
                        {t('page.setting.librarySyncDashboard.diagOnline', {
                            defaultValue: 'Network',
                        })}
                    </Text>
                    <Text c={diagnostics.online ? 'dimmed' : 'yellow'} size="sm">
                        {diagnostics.online
                            ? t('page.setting.librarySyncDashboard.diagOnlineYes', {
                                  defaultValue: 'online',
                              })
                            : t('page.setting.librarySyncDashboard.diagOnlineNo', {
                                  defaultValue: 'offline',
                              })}
                    </Text>
                </Group>
                <Group gap="md" justify="space-between">
                    <Text size="sm">
                        {t('page.setting.librarySyncDashboard.diagCacheAvailable', {
                            defaultValue: 'IndexedDB available',
                        })}
                    </Text>
                    <Text c="dimmed" size="sm">
                        {platformCapable === null ? '—' : platformCapable ? 'yes' : 'no'}
                    </Text>
                </Group>
                <Group gap="md" justify="space-between">
                    <Text size="sm">
                        {t('page.setting.librarySyncDashboard.diagBuild', {
                            defaultValue: 'Build',
                        })}
                    </Text>
                    <Text c="dimmed" size="sm">
                        v{packageJson.version}
                    </Text>
                </Group>
                <Group justify="flex-end" mt="xs">
                    <ConsoleLogViewer />
                </Group>
            </Stack>

            {/* Storage usage */}
            <Stack gap="xs">
                <Text c="dimmed">
                    {t('page.setting.librarySyncDashboard.storageUsed', {
                        cap: formatCap(capBytes),
                        used: formatBytes(bytesUsed),
                    })}
                </Text>
                {quotaCapped && sliderValue !== undefined && (
                    <Stack gap={4}>
                        <Group justify="space-between">
                            <Text size="sm">{t('page.setting.librarySyncDashboard.capLabel')}</Text>
                            <Text c="dimmed" size="sm">
                                {formatBytes(sliderValue)}
                            </Text>
                        </Group>
                        <Slider
                            label={(value) => formatBytes(value)}
                            max={SLIDER_MAX}
                            min={SLIDER_MIN}
                            onChange={setSliderValue}
                            onChangeEnd={handleSliderCommit}
                            step={SLIDER_STEP}
                            value={sliderValue}
                        />
                        <Text c="dimmed" size="xs">
                            {t('page.setting.librarySyncDashboard.capSliderHelp')}
                        </Text>
                    </Stack>
                )}
            </Stack>

            {/* Pending writes */}
            <Text>
                {t('page.setting.librarySyncDashboard.pendingMutations', {
                    count: pendingMutations,
                })}
            </Text>

            {/* Actions — the cache is always on, so these are only gated on
                a live server / an active sweep. */}
            <Group>
                <Button
                    disabled={sweeping || !currentServer}
                    onClick={() => currentServer && handleSyncNow(currentServer)}
                >
                    {t('page.setting.librarySyncDashboard.actionSyncNow')}
                </Button>
                {sweeping && (
                    <Button onClick={handlePause} variant="default">
                        {t('page.setting.librarySyncDashboard.actionPause')}
                    </Button>
                )}
                <Button
                    disabled={!currentServer}
                    onClick={() => currentServer && void handleResync(currentServer)}
                    variant="default"
                >
                    {t('page.setting.librarySyncDashboard.actionResync')}
                </Button>
                <Button
                    disabled={!currentServer}
                    onClick={() => currentServer && void handleForceFullResync(currentServer)}
                    variant="default"
                >
                    {t('page.setting.librarySyncDashboard.actionForceFullResync', {
                        defaultValue: 'Force full re-sync',
                    })}
                </Button>
                <Button onClick={() => void handleClearThumbnails()} variant="default">
                    {t('page.setting.librarySyncDashboard.actionClearThumbnails')}
                </Button>
                <Button color="red" onClick={() => void handleClearAll()} variant="filled">
                    {t('page.setting.librarySyncDashboard.actionClearAll')}
                </Button>
            </Group>
        </Stack>
    );
};
