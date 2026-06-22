import type { OfflineEntityType, OfflineTargetRow } from '/@/renderer/cache/types';

import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Divider,
    Group,
    Loader,
    Progress,
    ScrollArea,
    Slider,
    Stack,
    Switch,
    Table,
    Text,
    TextInput,
    Title,
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RiAddLine, RiDeleteBinLine, RiRefreshLine } from 'react-icons/ri';

import { api } from '/@/renderer/api';
import { getActiveVolume, refreshVolumes } from '/@/renderer/cache/backends/active-backend';
import { isAndroidNative } from '/@/renderer/cache/backends/volumes';
import { formatBytes } from '/@/renderer/cache/format';
import { localMediaStore, requestPersistentStorage } from '/@/renderer/cache/media-store';
import {
    addAndSyncOfflineTarget,
    cancelOfflineSync,
    refreshOfflineStats,
    removeAllTargets,
    removeOfflineTarget,
    syncAllTargets,
    syncTarget,
} from '/@/renderer/cache/offline-media';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSmoothOfflineSync } from '/@/renderer/cache/use-smooth-offline-sync';
import { StorageLocationSettings } from '/@/renderer/features/settings/components/connect/storage-location-settings';
import { useAuthStore, useSettingsStore } from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import {
    AlbumArtistListSort,
    AlbumListSort,
    GenreListSort,
    PlaylistListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SLIDER_MIN = 256 * MIB;
const SLIDER_MAX = 32 * GIB;
const SLIDER_STEP = 256 * MIB;

const STATUS_COLOR: Record<OfflineTargetRow['Status'], string> = {
    complete: 'green',
    error: 'red',
    idle: 'gray',
    partial: 'yellow',
    syncing: 'blue',
};

const safeConfirm = (message: string): boolean => {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
    return window.confirm(message);
};

interface PickResult {
    entityType: OfflineEntityType;
    id: string;
    name: string;
}

export const OfflineMediaSettings = () => {
    const { t } = useTranslation();
    const currentServer = useAuthStore((s) => s.currentServer);
    const cacheAvailable = useCacheStore((s) => s.cacheAvailable);
    const stats = useCacheStore((s) => s.offlineMedia);
    const smoothSync = useSmoothOfflineSync();

    const cacheEnabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const offlineCfg = useSettingsStore((s) => s.localCache?.offlineMedia);
    const androidCfg = useSettingsStore((s) => s.localCache?.android);
    const setLocalCache = useSettingsStore((s) => s.actions.setLocalCache);
    const backgroundSync = androidCfg?.backgroundSync !== false;

    const [targets, setTargets] = useState<OfflineTargetRow[]>([]);
    const [loadingTargets, setLoadingTargets] = useState(false);
    const [sliderValue, setSliderValue] = useState<number>(offlineCfg?.maxBytes ?? 2 * GIB);
    // Free space on the active storage volume (SD card). The cap should scale to
    // it instead of a hardcoded 32 GiB ceiling — a 1 TB card was uselessly
    // capped at ~34 GB before. Undefined on internal storage / IDB.
    const [volumeFreeBytes, setVolumeFreeBytes] = useState<number | undefined>(undefined);

    // Add affordance state.
    const [searchTerm, setSearchTerm] = useState('');
    const [searching, setSearching] = useState(false);
    const [results, setResults] = useState<PickResult[]>([]);
    const searchSeq = useRef(0);

    const maxBytes = offlineCfg?.maxBytes ?? 2 * GIB;
    const isSyncing = Boolean(smoothSync);

    // Refresh the active volume's free space so the cap slider can scale to a
    // big SD card. Re-runs when the chosen volume changes.
    useEffect(() => {
        if (!isAndroidNative()) return undefined;
        let cancelled = false;
        void refreshVolumes().then(() => {
            if (!cancelled) setVolumeFreeBytes(getActiveVolume()?.freeBytes);
        });
        return () => {
            cancelled = true;
        };
    }, [androidCfg?.storageVolumeId]);

    // Slider ceiling: the volume's free space + what's already used (so the
    // current cap is always reachable), rounded up to a GiB; never below the
    // fixed 32 GiB default (internal storage / IDB).
    const sliderMax = useMemo(() => {
        if (volumeFreeBytes && volumeFreeBytes > 0) {
            return Math.max(SLIDER_MAX, Math.ceil((volumeFreeBytes + stats.bytesUsed) / GIB) * GIB);
        }
        return SLIDER_MAX;
    }, [volumeFreeBytes, stats.bytesUsed]);

    const refreshTargets = useCallback(async () => {
        setLoadingTargets(true);
        try {
            const rows = await localMediaStore.listTargets();
            setTargets(rows);
            await refreshOfflineStats();
        } catch (err) {
            console.warn('[offline-media] settings: list failed', err);
        } finally {
            setLoadingTargets(false);
        }
    }, []);

    useEffect(() => {
        if (!cacheEnabled) return;
        void requestPersistentStorage();
        void refreshTargets();
    }, [cacheEnabled, refreshTargets]);

    // Re-list targets when an in-flight sync transitions (start/finish) so the
    // row statuses + byte counts track the download.
    const syncEntityKey = smoothSync?.entityKey;
    useEffect(() => {
        if (!cacheEnabled) return undefined;
        void refreshTargets();
        const interval = isSyncing ? setInterval(() => void refreshTargets(), 1000) : undefined;
        return () => {
            if (interval) clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncEntityKey, isSyncing, cacheEnabled]);

    useEffect(() => {
        setSliderValue(maxBytes);
    }, [maxBytes]);

    const handleCommitCap = useCallback(
        (bytes: number) => {
            setLocalCache({
                offlineMedia: {
                    downloadOriginal: offlineCfg?.downloadOriginal ?? true,
                    maxBytes: bytes,
                },
            });
        },
        [offlineCfg?.downloadOriginal, setLocalCache],
    );

    const handleToggleBackgroundSync = useCallback(
        (checked: boolean) => {
            setLocalCache({
                android: {
                    backgroundSync: checked,
                    blobBackendVersion: androidCfg?.blobBackendVersion ?? 0,
                    storageRootPath: androidCfg?.storageRootPath ?? null,
                    storageVolumeId: androidCfg?.storageVolumeId ?? null,
                },
            });
        },
        [androidCfg, setLocalCache],
    );

    const handleSearch = useCallback(async () => {
        if (!currentServer || !searchTerm.trim()) {
            setResults([]);
            return;
        }
        const seq = (searchSeq.current += 1);
        setSearching(true);
        try {
            const apiClientProps = { serverId: currentServer.id };
            const term = searchTerm.trim();
            const [albums, artists, genres, playlists] = await Promise.all([
                api.controller.getAlbumList({
                    apiClientProps,
                    query: {
                        limit: 10,
                        searchTerm: term,
                        sortBy: AlbumListSort.NAME,
                        sortOrder: SortOrder.ASC,
                        startIndex: 0,
                    },
                }),
                api.controller
                    .getAlbumArtistList({
                        apiClientProps,
                        query: {
                            limit: 10,
                            searchTerm: term,
                            sortBy: AlbumArtistListSort.NAME,
                            sortOrder: SortOrder.ASC,
                            startIndex: 0,
                        },
                    })
                    .catch(() => undefined),
                api.controller
                    .getGenreList({
                        apiClientProps,
                        query: {
                            limit: 10,
                            searchTerm: term,
                            sortBy: GenreListSort.NAME,
                            sortOrder: SortOrder.ASC,
                            startIndex: 0,
                        },
                    })
                    .catch(() => undefined),
                api.controller
                    .getPlaylistList({
                        apiClientProps,
                        query: {
                            limit: 10,
                            searchTerm: term,
                            sortBy: PlaylistListSort.NAME,
                            sortOrder: SortOrder.ASC,
                            startIndex: 0,
                        },
                    })
                    .catch(() => undefined),
            ]);
            if (seq !== searchSeq.current) return;
            const albumPicks: PickResult[] = (albums?.items ?? []).map((a) => ({
                entityType: 'album',
                id: a.id,
                name: a.name,
            }));
            const artistPicks: PickResult[] = (artists?.items ?? []).map((a) => ({
                entityType: 'artist',
                id: a.id,
                name: a.name,
            }));
            const genrePicks: PickResult[] = (genres?.items ?? []).map((g) => ({
                entityType: 'genre',
                id: g.id,
                name: g.name,
            }));
            const playlistPicks: PickResult[] = (playlists?.items ?? []).map((p) => ({
                entityType: 'playlist',
                id: p.id,
                name: p.name,
            }));
            setResults([...albumPicks, ...artistPicks, ...genrePicks, ...playlistPicks]);
        } catch (err) {
            console.warn('[offline-media] settings: search failed', err);
            if (seq === searchSeq.current) setResults([]);
        } finally {
            if (seq === searchSeq.current) setSearching(false);
        }
    }, [currentServer, searchTerm]);

    const handleAdd = useCallback(
        async (pick: PickResult) => {
            if (!currentServer) return;
            try {
                console.info('[offline-media] settings: add target', pick);
                setResults([]);
                setSearchTerm('');
                await addAndSyncOfflineTarget({
                    entityId: pick.id,
                    entityType: pick.entityType,
                    name: pick.name,
                    serverId: currentServer.id,
                });
                await refreshTargets();
            } catch (err) {
                console.warn('[offline-media] settings: add failed', err);
                toast.error({ message: (err as Error).message ?? String(err) });
            }
        },
        [currentServer, refreshTargets],
    );

    const handleSyncRow = useCallback(
        async (target: OfflineTargetRow) => {
            try {
                await syncTarget({ target });
                await refreshTargets();
            } catch (err) {
                toast.error({ message: (err as Error).message ?? String(err) });
            }
        },
        [refreshTargets],
    );

    const handleRemoveRow = useCallback(
        async (target: OfflineTargetRow) => {
            if (
                !safeConfirm(
                    t('page.setting.offlineMedia.confirmRemove', {
                        defaultValue: 'Remove "{{name}}" from offline?',
                        name: target.Name,
                    }),
                )
            ) {
                return;
            }
            try {
                await removeOfflineTarget(target.Key);
                await refreshTargets();
            } catch (err) {
                toast.error({ message: (err as Error).message ?? String(err) });
            }
        },
        [refreshTargets, t],
    );

    const handleSyncAll = useCallback(async () => {
        try {
            await syncAllTargets();
            await refreshTargets();
        } catch (err) {
            toast.error({ message: (err as Error).message ?? String(err) });
        }
    }, [refreshTargets]);

    const handleRemoveAll = useCallback(async () => {
        if (
            !safeConfirm(
                t('page.setting.offlineMedia.confirmRemoveAll', {
                    defaultValue: 'Remove ALL offline downloads? This frees the storage they use.',
                }),
            )
        ) {
            return;
        }
        try {
            await removeAllTargets();
            await refreshTargets();
        } catch (err) {
            toast.error({ message: (err as Error).message ?? String(err) });
        }
    }, [refreshTargets, t]);

    const usagePct = useMemo(() => {
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
        return Math.min(100, (100 * stats.bytesUsed) / maxBytes);
    }, [maxBytes, stats.bytesUsed]);

    const entityTypeLabel = (type: OfflineEntityType): string =>
        t(`page.setting.offlineMedia.type.${type}`, { defaultValue: type });

    if (cacheAvailable === false) {
        return (
            <Stack gap="md">
                <Title order={3}>
                    {t('page.setting.offlineMedia.title', { defaultValue: 'Offline downloads' })}
                </Title>
                <Alert color="yellow">
                    {t('page.setting.offlineMedia.unavailable', {
                        defaultValue:
                            'Local storage (IndexedDB) is unavailable on this platform, so offline downloads cannot be stored.',
                    })}
                </Alert>
            </Stack>
        );
    }

    if (!cacheEnabled) {
        return (
            <Stack gap="md">
                <Title order={3}>
                    {t('page.setting.offlineMedia.title', { defaultValue: 'Offline downloads' })}
                </Title>
                <Alert color="yellow">
                    {t('page.setting.offlineMedia.requiresCache', {
                        defaultValue:
                            'Offline downloads require the local library cache. Enable it under Library sync first.',
                    })}
                </Alert>
            </Stack>
        );
    }

    return (
        <Stack gap="lg">
            <Stack gap="xs">
                <Title order={3}>
                    {t('page.setting.offlineMedia.title', { defaultValue: 'Offline downloads' })}
                </Title>
                <Text c="dimmed">
                    {t('page.setting.offlineMedia.description', {
                        defaultValue:
                            'Download albums and playlists for offline playback. Songs play from local storage when downloaded — including when the server is unreachable.',
                    })}
                </Text>
            </Stack>

            {/* Storage usage + cap */}
            <Stack gap="xs">
                <Group justify="space-between">
                    <Text>
                        {t('page.setting.offlineMedia.storageUsed', {
                            cap: formatBytes(maxBytes),
                            defaultValue: '{{used}} of {{cap}} used',
                            used: formatBytes(stats.bytesUsed),
                        })}
                    </Text>
                    <Text c="dimmed" size="sm">
                        {t('page.setting.offlineMedia.itemsLine', {
                            count: stats.itemsDownloaded,
                            defaultValue: '{{count}} songs · {{targets}} items',
                            targets: stats.targetCount,
                        })}
                    </Text>
                </Group>
                <Progress value={usagePct} />
                <Group justify="space-between">
                    <Text size="sm">
                        {t('page.setting.offlineMedia.capLabel', {
                            defaultValue: 'Storage limit',
                        })}
                    </Text>
                    <Text c="dimmed" size="sm">
                        {formatBytes(sliderValue)}
                    </Text>
                </Group>
                <Slider
                    label={(v) => formatBytes(v)}
                    max={sliderMax}
                    min={SLIDER_MIN}
                    onChange={setSliderValue}
                    onChangeEnd={handleCommitCap}
                    step={SLIDER_STEP}
                    value={sliderValue}
                />
            </Stack>

            {/* Storage location (Android only — renders null elsewhere) */}
            <StorageLocationSettings />

            {/* Keep syncing in the background (Android only) */}
            {isAndroidNative() && (
                <Stack gap="xs">
                    <Title order={6}>
                        {t('page.setting.offlineMedia.backgroundSyncTitle', {
                            defaultValue: 'Keep syncing in the background',
                        })}
                    </Title>
                    <Switch
                        checked={backgroundSync}
                        description={t('page.setting.offlineMedia.backgroundSyncDescription', {
                            defaultValue:
                                'Keep library and offline-download syncs running while the app is in the background or the screen is locked. Shows a progress notification you can pause or stop.',
                        })}
                        label={t('page.setting.offlineMedia.backgroundSyncLabel', {
                            defaultValue: 'Sync in the background',
                        })}
                        onChange={(e) => handleToggleBackgroundSync(e.currentTarget.checked)}
                    />
                </Stack>
            )}

            {/* Live download progress */}
            {smoothSync && (
                <Stack gap={4}>
                    <Text>
                        {t('page.setting.offlineMedia.downloading', {
                            defaultValue: 'Downloading {{name}}',
                            name: smoothSync.name,
                        })}
                    </Text>
                    <Progress
                        value={
                            smoothSync.total
                                ? Math.min(100, (100 * smoothSync.done) / smoothSync.total)
                                : 0
                        }
                    />
                    <Text c="dimmed" size="sm">
                        {Math.floor(smoothSync.done)}/{smoothSync.total ?? '?'} ·{' '}
                        {formatBytes(smoothSync.bytesDownloaded)}
                        {smoothSync.estimatedTotalBytes &&
                        smoothSync.estimatedTotalBytes > smoothSync.bytesDownloaded
                            ? ` · ~${formatBytes(
                                  smoothSync.estimatedTotalBytes - smoothSync.bytesDownloaded,
                              )} ${t('page.setting.offlineMedia.remaining', {
                                  defaultValue: 'remaining',
                              })}`
                            : ''}{' '}
                        · {formatBytes(smoothSync.bytesPerSec)}/s
                    </Text>
                    <Group>
                        <Button onClick={() => cancelOfflineSync()} size="xs" variant="default">
                            {t('page.setting.offlineMedia.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                    </Group>
                </Stack>
            )}

            <Divider />

            {/* Add affordance */}
            <Stack gap="xs">
                <Title order={6}>
                    {t('page.setting.offlineMedia.addTitle', {
                        defaultValue: 'Add an album, artist, genre, or playlist',
                    })}
                </Title>
                <Group>
                    <TextInput
                        onChange={(e) => setSearchTerm(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSearch();
                        }}
                        placeholder={t('page.setting.offlineMedia.searchPlaceholder', {
                            defaultValue: 'Search albums / artists / genres / playlists…',
                        })}
                        style={{ flex: 1 }}
                        value={searchTerm}
                    />
                    <Button
                        disabled={!searchTerm.trim() || !currentServer}
                        leftSection={<RiAddLine />}
                        onClick={() => void handleSearch()}
                    >
                        {t('page.setting.offlineMedia.searchButton', { defaultValue: 'Search' })}
                    </Button>
                </Group>
                {searching && <Loader size="sm" />}
                {!searching && results.length > 0 && (
                    <Stack gap={2}>
                        {results.map((r) => (
                            <Group justify="space-between" key={`${r.entityType}:${r.id}`}>
                                <Group gap="xs">
                                    <Badge variant="light">{entityTypeLabel(r.entityType)}</Badge>
                                    <Text size="sm">{r.name}</Text>
                                </Group>
                                <Button onClick={() => void handleAdd(r)} size="xs" variant="light">
                                    {t('page.setting.offlineMedia.addAndDownload', {
                                        defaultValue: 'Download',
                                    })}
                                </Button>
                            </Group>
                        ))}
                    </Stack>
                )}
            </Stack>

            <Divider />

            {/* Target list */}
            <Stack gap="xs">
                <Group justify="space-between">
                    <Title order={6}>
                        {t('page.setting.offlineMedia.targetsTitle', {
                            defaultValue: 'Offline items',
                        })}
                    </Title>
                    {loadingTargets && <Loader size="xs" />}
                </Group>
                {targets.length === 0 ? (
                    <Text c="dimmed" size="sm">
                        {t('page.setting.offlineMedia.empty', {
                            defaultValue: 'Nothing downloaded yet. Add an album or playlist above.',
                        })}
                    </Text>
                ) : (
                    <ScrollArea offsetScrollbars type="auto">
                        <Table miw={560}>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>
                                        {t('page.setting.offlineMedia.colName', {
                                            defaultValue: 'Name',
                                        })}
                                    </Table.Th>
                                    <Table.Th>
                                        {t('page.setting.offlineMedia.colType', {
                                            defaultValue: 'Type',
                                        })}
                                    </Table.Th>
                                    <Table.Th>
                                        {t('page.setting.offlineMedia.colSongs', {
                                            defaultValue: 'Songs',
                                        })}
                                    </Table.Th>
                                    <Table.Th>
                                        {t('page.setting.offlineMedia.colSize', {
                                            defaultValue: 'Size',
                                        })}
                                    </Table.Th>
                                    <Table.Th>
                                        {t('page.setting.offlineMedia.colStatus', {
                                            defaultValue: 'Status',
                                        })}
                                    </Table.Th>
                                    <Table.Th />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {targets.map((target) => (
                                    <Table.Tr key={target.Key}>
                                        <Table.Td>{target.Name}</Table.Td>
                                        <Table.Td>{entityTypeLabel(target.EntityType)}</Table.Td>
                                        <Table.Td>
                                            {target.DownloadedCount}
                                            {target.SongCount !== undefined
                                                ? `/${target.SongCount}`
                                                : ''}
                                        </Table.Td>
                                        <Table.Td>{formatBytes(target.Bytes)}</Table.Td>
                                        <Table.Td>
                                            <Badge
                                                color={STATUS_COLOR[target.Status]}
                                                variant="light"
                                            >
                                                {t(
                                                    `page.setting.offlineMedia.status.${target.Status}`,
                                                    {
                                                        defaultValue: target.Status,
                                                    },
                                                )}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap="xs" justify="flex-end" wrap="nowrap">
                                                <ActionIcon
                                                    aria-label="Sync now"
                                                    disabled={isSyncing}
                                                    onClick={() => void handleSyncRow(target)}
                                                    variant="subtle"
                                                >
                                                    <RiRefreshLine />
                                                </ActionIcon>
                                                <ActionIcon
                                                    aria-label="Remove"
                                                    color="red"
                                                    onClick={() => void handleRemoveRow(target)}
                                                    variant="subtle"
                                                >
                                                    <RiDeleteBinLine />
                                                </ActionIcon>
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </ScrollArea>
                )}

                <Group>
                    <Button
                        disabled={targets.length === 0 || isSyncing}
                        onClick={() => void handleSyncAll()}
                        variant="default"
                    >
                        {t('page.setting.offlineMedia.syncAll', { defaultValue: 'Sync all' })}
                    </Button>
                    <Button
                        color="red"
                        disabled={targets.length === 0}
                        onClick={() => void handleRemoveAll()}
                        variant="filled"
                    >
                        {t('page.setting.offlineMedia.removeAll', { defaultValue: 'Remove all' })}
                    </Button>
                </Group>
            </Stack>
        </Stack>
    );
};
