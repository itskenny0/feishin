// offline-media.ts — the download pipeline for per-entity offline playback.
//
// Given an offline target (an album / playlist / artist / genre / individual
// song), this enumerates the target's songs via the API controller, resolves
// each song's ORIGINAL (non-transcoded) download URL — the Jellyfin
// `/Items/{id}/Download` URL embeds the api key so a plain fetch() works —
// downloads each as a blob with bounded concurrency, and stores it via the
// LocalMediaStore. Progress is pushed to the cache Zustand store so the
// settings panel can render bytes-downloaded / estimated-remaining in SI units
// and animate smoothly via rAF interpolation.
//
// Limit enforcement: before each download we check the running total against
// the user's configured max-bytes cap. When the cap would be exceeded we stop
// the sync, mark the target `partial`, and surface it (status + console.warn).
//
// Lifecycle logging tagged `[offline-media]` at every boundary, per the
// project's "new subsystems ship with lifecycle logging" rule.

import type { Song } from '/@/shared/types/domain-types';

import type { LocalMediaStore } from './media-store';
import type { OfflineEntityType, OfflineTargetRow, OfflineTargetStatus } from './types';

import { api } from '/@/renderer/api';
import { localMediaStore, targetKey } from '/@/renderer/cache/media-store';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

const TAG = '[offline-media]';

const DEFAULT_CONCURRENCY = 3;
const ENUMERATE_PAGE = 500;

export interface AddTargetArgs {
    entityId: string;
    entityType: OfflineEntityType;
    name: string;
    serverId: string;
}

export interface SyncTargetArgs {
    // Optional injected store (tests). Defaults to the shared singleton.
    store?: LocalMediaStore;
    target: OfflineTargetRow;
}

// One sync runs at a time. The active controller is exposed so the UI / a
// fresh sync can cancel it.
let activeAbort: AbortController | undefined;
let activeKey: string | undefined;

export const isSyncing = (): boolean => Boolean(activeAbort);

export const cancelOfflineSync = (): void => {
    if (activeAbort) {
        console.info(`${TAG} cancel requested`, { key: activeKey });
        activeAbort.abort();
        activeAbort = undefined;
        activeKey = undefined;
    }
};

const getMaxBytes = (): number => {
    const cfg = useSettingsStore.getState().localCache?.offlineMedia;
    const n = cfg?.maxBytes;
    return typeof n === 'number' && n > 0 ? n : Number.POSITIVE_INFINITY;
};

const downloadOriginal = (): boolean =>
    useSettingsStore.getState().localCache?.offlineMedia?.downloadOriginal !== false;

/**
 * Enumerate the songs belonging to an offline target via the controller.
 * Returns an empty array on an unsupported/empty entity.
 */
export const enumerateTargetSongs = async (
    target: Pick<OfflineTargetRow, 'EntityId' | 'EntityType' | 'ServerId'>,
    signal?: AbortSignal,
): Promise<Song[]> => {
    const { EntityId: entityId, EntityType: entityType, ServerId: serverId } = target;
    const apiClientProps = { serverId, signal };

    if (entityType === 'album') {
        const album = await api.controller.getAlbumDetail({
            apiClientProps,
            query: { id: entityId },
        });
        return album?.songs ?? [];
    }

    if (entityType === 'playlist') {
        const out: Song[] = [];
        let startIndex = 0;
        // Playlists can be large; page through them.

        while (true) {
            const page = await api.controller.getPlaylistSongList({
                apiClientProps,
                query: { id: entityId, limit: ENUMERATE_PAGE, startIndex },
            });
            const items = page?.items ?? [];
            out.push(...items);
            if (items.length < ENUMERATE_PAGE) break;
            startIndex += ENUMERATE_PAGE;
        }
        return out;
    }

    if (entityType === 'song') {
        // Resolve the single song's full metadata row.
        const song = await api.controller.getSongDetail({
            apiClientProps,
            query: { id: entityId },
        });
        return song ? [song] : [];
    }

    // artist / genre — page the song list filtered by the relevant id.
    const out: Song[] = [];
    let startIndex = 0;

    while (true) {
        const page = await api.controller.getSongList({
            apiClientProps,
            query: {
                albumArtistIds: entityType === 'artist' ? [entityId] : undefined,
                genreIds: entityType === 'genre' ? [entityId] : undefined,
                limit: ENUMERATE_PAGE,
                sortBy: SongListSort.ALBUM,
                sortOrder: SortOrder.ASC,
                startIndex,
            },
        });
        const items = page?.items ?? [];
        out.push(...items);
        if (items.length < ENUMERATE_PAGE) break;
        startIndex += ENUMERATE_PAGE;
    }
    return out;
};

/** Resolve a song's original (non-transcoded) download URL. */
const resolveDownloadUrl = async (song: Song, serverId: string): Promise<string> =>
    api.controller.getStreamUrl({
        apiClientProps: { serverId },
        query: {
            id: song.id,
            // Original file, credentials embedded — a plain fetch works.
            skipAutoTranscode: downloadOriginal(),
            transcode: false,
        },
    });

/** Fetch a song's bytes as a Blob. */
const fetchSongBlob = async (url: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch(url, { signal });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} downloading offline audio`);
    }
    return res.blob();
};

/**
 * Refresh the aggregate offline-media stats in the cache store from the
 * persisted rows. Cheap enough to run after each target sync / removal.
 */
export const refreshOfflineStats = async (
    store: LocalMediaStore = localMediaStore,
): Promise<void> => {
    try {
        const [bytesUsed, itemsDownloaded, targets] = await Promise.all([
            store.totalBytes(),
            store.count(),
            store.listTargets(),
        ]);
        useCacheStore.getState().actions.setOfflineMedia({
            bytesUsed,
            itemsDownloaded,
            targetCount: targets.length,
        });
    } catch (err) {
        console.warn(`${TAG} refreshOfflineStats failed`, err);
    }
};

/**
 * Add (mark) an entity for offline download. Idempotent — re-adding an
 * existing target is a no-op that returns the existing row. Does NOT start the
 * download; call syncTarget() for that.
 */
export const addOfflineTarget = async (
    args: AddTargetArgs,
    store: LocalMediaStore = localMediaStore,
): Promise<OfflineTargetRow> => {
    const { entityId, entityType, name, serverId } = args;
    const key = targetKey(serverId, entityType, entityId);
    const existing = await store.getTarget(key);
    if (existing) return existing;
    const now = Date.now();
    const row: OfflineTargetRow = {
        AddedAt: now,
        Bytes: 0,
        DownloadedCount: 0,
        EntityId: entityId,
        EntityType: entityType,
        Key: key,
        LastError: undefined,
        Name: name,
        ServerId: serverId,
        SongCount: undefined,
        Status: 'idle',
        UpdatedAt: now,
    };
    await store.putTarget(row);
    console.info(`${TAG} target added`, { entityType, key, name });
    await refreshOfflineStats(store);
    return row;
};

/** Remove an offline target and reclaim any blobs it solely owned. */
export const removeOfflineTarget = async (
    key: string,
    store: LocalMediaStore = localMediaStore,
): Promise<void> => {
    if (activeKey === key) cancelOfflineSync();
    await store.removeTarget(key);
    await refreshOfflineStats(store);
};

/**
 * Download every song of a target with bounded concurrency, enforcing the
 * byte cap. Resolves when done (or when the cap/cancel stops it). Updates the
 * target row + the live offline-sync progress in the cache store throughout.
 */
export const syncTarget = async (args: SyncTargetArgs): Promise<OfflineTargetRow> => {
    const store = args.store ?? localMediaStore;
    const { target } = args;
    const { Key: key, Name: name, ServerId: serverId } = target;

    // Only one sync at a time; cancel any in-flight one for a different target.
    if (activeAbort && activeKey !== key) cancelOfflineSync();
    const abort = new AbortController();
    activeAbort = abort;
    activeKey = key;

    const setSync = useCacheStore.getState().actions.setOfflineSync;
    const startedAt = Date.now();

    const finish = async (
        status: OfflineTargetStatus,
        lastError?: string,
    ): Promise<OfflineTargetRow> => {
        if (activeKey === key) {
            activeAbort = undefined;
            activeKey = undefined;
        }
        setSync(undefined);
        await store.patchTarget(key, { LastError: lastError, Status: status });
        await refreshOfflineStats(store);
        const updated = (await store.getTarget(key)) ?? target;
        console.info(`${TAG} sync done`, { bytes: updated.Bytes, key, status });
        return updated;
    };

    console.info(`${TAG} sync start`, { key, name });
    await store.setTargetStatus(key, 'syncing');

    let songs: Song[];
    try {
        songs = await enumerateTargetSongs(target, abort.signal);
    } catch (err) {
        if (abort.signal.aborted) return finish('idle');
        console.warn(`${TAG} enumerate failed`, { err, key });
        return finish('error', (err as Error).message ?? String(err));
    }

    const total = songs.length;
    await store.patchTarget(key, { SongCount: total });

    // Seed progress from what's already downloaded (re-sync resumes).
    const existingBlobs = await store.listByEntity(key);
    let bytesDownloaded = existingBlobs.reduce((sum, b) => sum + b.ByteSize, 0);
    let done = existingBlobs.length;
    const haveAlready = new Set(existingBlobs.map((b) => b.SongId));

    const pushProgress = (): void => {
        const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
        const downloadedThisRun = done - existingBlobs.length;
        const bytesThisRun = bytesDownloaded - existingBlobs.reduce((s, b) => s + b.ByteSize, 0);
        const avgPerItem = done > 0 ? bytesDownloaded / done : 0;
        setSync({
            bytesDownloaded,
            bytesPerSec: bytesThisRun / elapsedSec,
            done,
            entityKey: key,
            estimatedTotalBytes: total > 0 && avgPerItem > 0 ? avgPerItem * total : undefined,
            itemsPerSec: downloadedThisRun / elapsedSec,
            name,
            startedAt,
            total,
        });
    };
    pushProgress();

    const pending = songs.filter((s) => !haveAlready.has(s.id));
    const maxBytes = getMaxBytes();
    let capHit = false;
    let failed = false;
    // Bytes committed OR reserved by an in-flight worker. Incremented
    // synchronously at the pre-fetch cap check (using the song's reported
    // size) so concurrent workers respect each other's reservations and the
    // cap is enforced deterministically rather than racing on the
    // post-download counter. Reconciled to the real size after each fetch.
    let reservedBytes = bytesDownloaded;

    // Bounded-concurrency worker pool over `pending`.
    const concurrency = Math.max(1, DEFAULT_CONCURRENCY);
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (!abort.signal.aborted && !capHit) {
            const index = cursor;
            cursor += 1;
            if (index >= pending.length) return;
            const song = pending[index];

            // Cap check — projected size if we add this song. We don't know
            // the exact size up front; use the song's reported size when
            // present, else a 1 MiB heuristic so an unknown-size song still
            // counts against the cap (better to under-fill than to blow it).
            const projected = song.size && song.size > 0 ? song.size : 1024 * 1024;
            if (Number.isFinite(maxBytes) && reservedBytes + projected > maxBytes) {
                capHit = true;
                console.warn(`${TAG} byte cap reached — stopping`, {
                    key,
                    maxBytes,
                    reservedBytes,
                });
                return;
            }
            // Reserve synchronously before yielding to the fetch.
            reservedBytes += projected;

            try {
                const url = await resolveDownloadUrl(song, serverId);
                const blob = await fetchSongBlob(url, abort.signal);
                // Reconcile the reservation to the real size.
                reservedBytes += blob.size - projected;
                // Re-check the cap against the real committed total before
                // writing — catches the case where the real size exceeded the
                // reservation enough to blow the cap.
                if (Number.isFinite(maxBytes) && bytesDownloaded + blob.size > maxBytes) {
                    reservedBytes -= blob.size;
                    capHit = true;
                    console.warn(`${TAG} byte cap reached after fetch — discarding`, {
                        key,
                        songId: song.id,
                    });
                    return;
                }
                const isNew = await store.save({
                    blob,
                    container: song.container ?? undefined,
                    entityKey: key,
                    serverId,
                    songId: song.id,
                });
                if (isNew) {
                    bytesDownloaded += blob.size;
                    done += 1;
                    console.info(`${TAG} item downloaded`, {
                        bytes: blob.size,
                        done,
                        key,
                        songId: song.id,
                        total,
                    });
                } else {
                    done += 1;
                }
                await store.patchTarget(key, { Bytes: bytesDownloaded, DownloadedCount: done });
                pushProgress();
            } catch (err) {
                // Release this song's reservation so a 404 doesn't
                // permanently eat cap headroom.
                reservedBytes -= projected;
                if (abort.signal.aborted) return;
                failed = true;
                console.warn(`${TAG} item failed`, { err, key, songId: song.id });
                // Keep going — a single 404 shouldn't abort the whole album.
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } catch (err) {
        console.warn(`${TAG} worker pool threw`, { err, key });
    }

    if (abort.signal.aborted) return finish('idle');
    if (capHit) return finish('partial', 'Storage cap reached');
    if (done < total || failed) return finish(failed ? 'error' : 'partial');
    return finish('complete');
};

/** Add a target and immediately start downloading it. */
export const addAndSyncOfflineTarget = async (
    args: AddTargetArgs,
    store: LocalMediaStore = localMediaStore,
): Promise<OfflineTargetRow> => {
    const target = await addOfflineTarget(args, store);
    return syncTarget({ store, target });
};

/** Re-download every known target sequentially. */
export const syncAllTargets = async (store: LocalMediaStore = localMediaStore): Promise<void> => {
    const targets = await store.listTargets();
    console.info(`${TAG} sync all`, { count: targets.length });
    for (const target of targets) {
        await syncTarget({ store, target });
    }
};

/** Remove every target and wipe all offline blobs. */
export const removeAllTargets = async (store: LocalMediaStore = localMediaStore): Promise<void> => {
    cancelOfflineSync();
    await store.clearAll();
    await refreshOfflineStats(store);
    console.info(`${TAG} removed all targets`);
};
