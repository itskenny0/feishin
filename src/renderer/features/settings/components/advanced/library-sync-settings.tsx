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
import { ImageVariantsRow } from '/@/renderer/features/settings/components/advanced/image-variants-settings';
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
    playlists: 'page.setting.librarySyncDashboard.entityPlaylists',
    songs: 'page.setting.librarySyncDashboard.entitySongs',
    thumbnails: 'page.setting.librarySyncDashboard.entityThumbnails',
};

const ENTITY_DISPLAY_ORDER: EntityType[] = [
    'artists',
    'genres',
    'albums',
    'songs',
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

export const LibrarySyncSettings = () => {
    const { t } = useTranslation();
    const currentServer = useAuthStore((s) => s.currentServer);
    // PLATFORM capability, not the store's `cacheAvailable` (that flag is
    // forced false while the cache is disabled — gating on it hid the enable
    // toggle behind "unavailable on this platform" for every opted-out
    // install; Windows portable, 2026-06-10).
    const platformCapable = usePlatformCacheCapability();
    const sweep = useCacheStore((s) => s.sweep);
    const smoothSweep = useSmoothSweep();
    const entityCounts = useCacheStore((s) => s.entityCounts);
    const hydrationStates = useCacheStore((s) => s.hydrationStates);
    const pendingMutations = useCacheStore((s) => s.pendingMutations);
    const bytesUsed = useCacheStore((s) => s.bytesUsed);
    const activeServer = useCacheStore((s) => s.activeServer);
    const cacheActions = useCacheStore((s) => s.actions);
    // Three-state opt-in flag. `true` = cache is active and the controls
    // below operate on a live DB. `false` / `undefined` = subsystem is
    // inert and we render a muted hint instead of letting the user fire
    // sync / clear actions against nothing.
    const cacheEnabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const setSettings = useSettingsStore((s) => s.actions.setSettings);
    const localCacheCap = useSettingsStore((s) => s.localCache?.capacityBytes);
    const setLocalCache = useSettingsStore((s) => s.actions.setLocalCache);
    const entities = useSettingsStore((s) => s.localCache?.entities);
    const thumbnailSizes = useSettingsStore((s) => s.localCache?.thumbnailSizes);
    const thumbnailConcurrency = useSettingsStore((s) => s.localCache?.thumbnailConcurrency);
    const sweepProgressSmoothing = useSettingsStore(
        (s) => s.localCache?.sweepProgressSmoothing ?? false,
    );

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
    // drives the in-sweep refresh cadence.
    const sweepEntity = sweep?.entity;
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
                const [count, bytes, metaRows, totalUsed] = await Promise.all([
                    db.thumbnails.count(),
                    cachedBytes(),
                    db.syncMeta.toArray(),
                    estimateBytes(),
                ]);
                if (cancelled) return;
                setThumbnailCount(count);
                setThumbnailBytes(bytes);
                // Bypass the lifecycle tick's throttle so the
                // "Storage used" line moves at the same cadence as
                // the per-entity counts above it. Without this the
                // user saw "Storage used: 0 MiB" while the sweep had
                // already landed hundreds of MB in Dexie.
                useCacheStore.getState().actions.setBytesUsed(totalUsed);
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

    const handleToggleEnabled = useCallback(() => {
        const next = !cacheEnabled;
        console.info('[cache] dashboard: master toggle', { next });
        setLocalCache({ enabled: next });
    }, [cacheEnabled, setLocalCache]);

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

    const sweepProgress =
        smoothSweep.entity && smoothSweep.total
            ? Math.min(100, (100 * smoothSweep.done) / smoothSweep.total)
            : 0;
    const sweeping = Boolean(sweep);
    const itemsPerSecLabel = smoothSweep.entity ? smoothSweep.itemsPerSec.toFixed(1) : '0';
    const sweepProgressLabel = smoothSweep.entity
        ? `${formatCount(smoothSweep.done)}/${smoothSweep.total ? formatCount(smoothSweep.total) : '?'} · ${itemsPerSecLabel} items/sec`
        : '';
    // Build the sweep bytes label. The previous "downloaded / total"
    // format was misleading when most remaining items were cache hits
    // or miss markers — the projected total reflected only the
    // bytes that will be downloaded THIS RUN, but the user parsed it
    // as total cache size. New format shows "downloaded" + "remaining"
    // explicitly so it's clear what the second number means. The
    // Storage used line below covers actual on-disk size.
    const sweepBytesLabel = (() => {
        if (!smoothSweep.entity) return '';
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
        <Stack gap="lg">
            {/* Header */}
            <Stack gap="xs">
                <Title order={3}>{t('page.setting.librarySync')}</Title>
                <Text c="dimmed">{t('page.setting.librarySyncDescription')}</Text>
            </Stack>

            {/* Master toggle — gates the entire subsystem. When off the
                controls below remain visible but inert so the user can
                explore them before opting in. */}
            <Stack gap={4}>
                <Switch
                    checked={cacheEnabled}
                    label={t('page.setting.librarySyncDashboard.masterToggleLabel')}
                    onChange={handleToggleEnabled}
                />
                {!cacheEnabled && (
                    <Text c="dimmed" size="sm">
                        {t('page.setting.librarySyncDashboard.masterToggleHint')}
                    </Text>
                )}
            </Stack>

            {/* Per-entity toggles */}
            {cacheEnabled && (
                <Stack gap="xs">
                    <Title order={6}>
                        {t('page.setting.librarySyncDashboard.entityTogglesTitle', {
                            defaultValue: 'What to sync',
                        })}
                    </Title>
                    <Text c="dimmed" size="sm">
                        {t('page.setting.librarySyncDashboard.entityTogglesHint', {
                            defaultValue:
                                'Pick which library types the sync downloads to local storage. Disabled entries are skipped on the next sync.',
                        })}
                    </Text>
                    <Stack gap={4}>
                        {ENTITY_DISPLAY_ORDER.map((entity) => {
                            const checked = entities?.[entity as keyof typeof entities] !== false;
                            return (
                                <Switch
                                    checked={checked}
                                    key={`entity-toggle-${entity}`}
                                    label={t(ENTITY_LABEL_KEYS[entity])}
                                    onChange={(e) => {
                                        const next = e.currentTarget.checked;
                                        // Build the next entities object
                                        // imperatively. The previous
                                        // implementation used a single
                                        // literal with `[entity]: next`
                                        // alongside explicit per-entity
                                        // keys; the perfectionist lint
                                        // rule re-sorted them alpha-
                                        // betically, which dropped the
                                        // computed key into the middle
                                        // of the literal — so toggling
                                        // any entity sorted after
                                        // `artists` (favorites / genres
                                        // / playlists / songs) was
                                        // silently a no-op because the
                                        // later explicit key won.
                                        const updated = {
                                            albums: entities?.albums ?? true,
                                            artists: entities?.artists ?? true,
                                            favorites: entities?.favorites ?? true,
                                            genres: entities?.genres ?? true,
                                            playlists: entities?.playlists ?? true,
                                            songs: entities?.songs ?? true,
                                        };
                                        updated[entity as keyof typeof updated] = next;
                                        setLocalCache({ entities: updated });
                                    }}
                                />
                            );
                        })}
                    </Stack>

                    <Title mt="sm" order={6}>
                        {t('page.setting.librarySyncDashboard.thumbnailsTitle', {
                            defaultValue: 'Thumbnail pre-cache',
                        })}
                    </Title>
                    <Text c="dimmed" size="sm">
                        {t('page.setting.librarySyncDashboard.thumbnailsHint', {
                            defaultValue:
                                'Pre-cache all artwork at the largest display size so the grid renders instantly. Disable if you want lazy fetching only.',
                        })}
                    </Text>
                    <Switch
                        checked={(thumbnailSizes ?? []).length > 0}
                        label={t('page.setting.librarySyncDashboard.thumbnailsToggleLabel', {
                            defaultValue: 'Pre-cache thumbnails',
                        })}
                        onChange={(e) => {
                            // The `thumbnailSizes` array is vestigial — the
                            // cache now stores one blob per item at
                            // MAX_CACHE_SIZE. Treat non-empty as "enabled"
                            // and empty as "opt-out"; write `['itemCard']`
                            // as the sentinel so older builds still
                            // recognise the setting as populated.
                            setLocalCache({
                                thumbnailSizes: e.currentTarget.checked ? ['itemCard'] : [],
                            });
                        }}
                    />

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

                    {/* Progress bar animation toggle */}
                    <Stack gap={4} mt="sm">
                        <Switch
                            checked={sweepProgressSmoothing}
                            label={t('page.setting.librarySyncDashboard.smoothProgressLabel', {
                                defaultValue: 'Animate sync progress bar',
                            })}
                            onChange={(e) =>
                                setLocalCache({ sweepProgressSmoothing: e.currentTarget.checked })
                            }
                        />
                        <Text c="dimmed" size="xs">
                            {t('page.setting.librarySyncDashboard.smoothProgressHelp', {
                                defaultValue:
                                    'Interpolates the counter and progress bar between page updates at 20 fps. Smoother visuals but uses slightly more CPU while this page is open.',
                            })}
                        </Text>
                    </Stack>

                    {/* Multi-resolution artwork variant cache. Caches several
                        cover sizes per item so dense lists/grids load without
                        decoding full-res JPEGs. The editor lives in its own
                        drill-down subpage; this row shows a summary + chevron. */}
                    <ImageVariantsRow
                        onOpen={() => setSettings({ tabSubpage: 'image-variants' })}
                    />
                </Stack>
            )}

            {/* Status + current sweep */}
            <Stack gap="xs">
                {sweep ? (
                    <>
                        <Text>
                            {t('page.setting.librarySyncDashboard.statusSweeping', {
                                entity: t(ENTITY_LABEL_KEYS[sweep.entity]),
                            })}
                            {smoothSweep.pageIndex !== undefined &&
                            smoothSweep.pageTotal !== undefined
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
                ) : (
                    <Text>{t('page.setting.librarySyncDashboard.statusIdle')}</Text>
                )}
            </Stack>

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

            {/* Actions — all disabled when the cache subsystem is off, so
                the user can't fire mutations against an inert DB. */}
            <Group>
                <Button
                    disabled={!cacheEnabled || sweeping || !currentServer}
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
                    disabled={!cacheEnabled || !currentServer}
                    onClick={() => currentServer && void handleResync(currentServer)}
                    variant="default"
                >
                    {t('page.setting.librarySyncDashboard.actionResync')}
                </Button>
                <Button
                    disabled={!cacheEnabled || !currentServer}
                    onClick={() => currentServer && void handleForceFullResync(currentServer)}
                    variant="default"
                >
                    {t('page.setting.librarySyncDashboard.actionForceFullResync', {
                        defaultValue: 'Force full re-sync',
                    })}
                </Button>
                <Button
                    disabled={!cacheEnabled}
                    onClick={() => void handleClearThumbnails()}
                    variant="default"
                >
                    {t('page.setting.librarySyncDashboard.actionClearThumbnails')}
                </Button>
                <Button
                    color="red"
                    disabled={!cacheEnabled}
                    onClick={() => void handleClearAll()}
                    variant="filled"
                >
                    {t('page.setting.librarySyncDashboard.actionClearAll')}
                </Button>
            </Group>
        </Stack>
    );
};
