import type { EntityType } from '/@/renderer/cache/types';
import type { ServerListItem } from '/@/shared/types/domain-types';

import { Capacitor } from '@capacitor/core';
import { Alert, Button, Group, Progress, Slider, Stack, Switch, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    formatBytes as formatBytesSI,
    formatCount,
    getActiveCacheDb,
    hydrate,
    useCacheStore,
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

const safeConfirm = (message: string): boolean => {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
    return window.confirm(message);
};

export const LibrarySyncSettings = () => {
    const { t } = useTranslation();
    const currentServer = useAuthStore((s) => s.currentServer);
    const cacheAvailable = useCacheStore((s) => s.cacheAvailable);
    const sweep = useCacheStore((s) => s.sweep);
    const smoothSweep = useSmoothSweep();
    const entityCounts = useCacheStore((s) => s.entityCounts);
    const hydrationStates = useCacheStore((s) => s.hydrationStates);
    const pendingMutations = useCacheStore((s) => s.pendingMutations);
    const bytesUsed = useCacheStore((s) => s.bytesUsed);
    const activeServer = useCacheStore((s) => s.activeServer);
    // Three-state opt-in flag. `true` = cache is active and the controls
    // below operate on a live DB. `false` / `undefined` = subsystem is
    // inert and we render a muted hint instead of letting the user fire
    // sync / clear actions against nothing.
    const cacheEnabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const localCacheCap = useSettingsStore((s) => s.localCache?.capacityBytes);
    const setLocalCache = useSettingsStore((s) => s.actions.setLocalCache);
    const entities = useSettingsStore((s) => s.localCache?.entities);
    const thumbnailSizes = useSettingsStore((s) => s.localCache?.thumbnailSizes);
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
    // on mount, whenever the sweep state changes, and on server switch.
    // Reads everything in one batch so the dashboard is consistent.
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
        void (async () => {
            try {
                // Use cachedBytes() (which reads the ByteSize index
                // instead of materialising every Blob). The dashboard
                // refresh fires repeatedly during a sweep — pulling
                // hundreds of MB of blobs out of IndexedDB on each
                // refresh was the dominant contributor to slow
                // thumbnail downloads.
                const [count, bytes, metaRows] = await Promise.all([
                    db.thumbnails.count(),
                    cachedBytes(),
                    db.syncMeta.toArray(),
                ]);
                if (cancelled) return;
                setThumbnailCount(count);
                setThumbnailBytes(bytes);
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
        })();
        return () => {
            cancelled = true;
        };
    }, [sweep, activeServer]);

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

    const handleResync = useCallback(
        async (server: ServerListItem) => {
            if (!safeConfirm(t('page.setting.librarySyncDashboard.confirmResync'))) return;
            try {
                console.info('[cache] dashboard: re-sync confirmed');
                await clearAllCacheData();
                void hydrate(server, 'full');
                await refreshBytesUsed();
            } catch (err) {
                console.warn('[cache] dashboard: re-sync failed', { err });
                toast.error({ message: (err as Error).message ?? String(err) });
            }
        },
        [refreshBytesUsed, t],
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

    const handleClearAll = useCallback(async () => {
        if (!safeConfirm(t('page.setting.librarySyncDashboard.confirmClearAll'))) return;
        try {
            console.info('[cache] dashboard: clear all confirmed');
            await clearAllCacheData();
            setThumbnailCount(0);
            await refreshBytesUsed();
        } catch (err) {
            console.warn('[cache] dashboard: clear all failed', { err });
            toast.error({ message: (err as Error).message ?? String(err) });
        }
    }, [refreshBytesUsed, t]);

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

    if (cacheAvailable === false) {
        return (
            <Stack gap="md">
                <Title order={3}>{t('page.setting.librarySync')}</Title>
                <Alert color="yellow">
                    {t('page.setting.librarySyncDashboard.statusUnavailable')}
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
    const sweepBytesLabel = smoothSweep.entity
        ? `${formatBytesSI(smoothSweep.bytesDownloaded)}${
              smoothSweep.estimatedTotalBytes
                  ? ` / ${formatBytesSI(smoothSweep.estimatedTotalBytes)}`
                  : ''
          } · ${formatBytesSI(smoothSweep.bytesPerSec)}/s`
        : '';

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
                                        setLocalCache({
                                            entities: {
                                                albums: entities?.albums ?? true,
                                                artists: entities?.artists ?? true,
                                                [entity]: next,
                                                favorites: entities?.favorites ?? true,
                                                genres: entities?.genres ?? true,
                                                playlists: entities?.playlists ?? true,
                                                songs: entities?.songs ?? true,
                                            },
                                        });
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
                                'Pick image sizes to download during sync. Empty = cover art is fetched lazily as you browse. Pre-caching trades disk space for instant grid rendering.',
                        })}
                    </Text>
                    <Stack gap={4}>
                        {(
                            ['itemCard', 'header', 'sidebar', 'table', 'fullScreenPlayer'] as const
                        ).map((bucket) => {
                            const checked = (thumbnailSizes ?? []).includes(bucket);
                            return (
                                <Switch
                                    checked={checked}
                                    key={`thumb-size-${bucket}`}
                                    label={t(
                                        `page.setting.librarySyncDashboard.thumbnailSize_${bucket}`,
                                        {
                                            defaultValue: bucket,
                                        },
                                    )}
                                    onChange={(e) => {
                                        const current = new Set(thumbnailSizes ?? []);
                                        if (e.currentTarget.checked) current.add(bucket);
                                        else current.delete(bucket);
                                        setLocalCache({
                                            thumbnailSizes: Array.from(current),
                                        });
                                    }}
                                />
                            );
                        })}
                    </Stack>

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
            )}

            {/* Status + current sweep */}
            <Stack gap="xs">
                {sweep ? (
                    <>
                        <Text>
                            {t('page.setting.librarySyncDashboard.statusSweeping', {
                                entity: t(ENTITY_LABEL_KEYS[sweep.entity]),
                            })}
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
                        {cacheAvailable === undefined ? '—' : cacheAvailable ? 'yes' : 'no'}
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
