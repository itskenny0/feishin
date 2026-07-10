// LocalMediaStore — the audio-blob backend for per-entity offline playback.
//
// This wraps the Dexie `mediaBlobs` / `offlineTargets` tables behind a small
// class so a native-filesystem backend (Capacitor Filesystem on iOS/Android,
// or an Electron file-backed store for MPV local playback) can replace
// IndexedDB later without touching the download pipeline or the playback
// substitution. IndexedDB is the universal backend: it works on the Electron
// renderer, the Android WebView, and web/PWA.
//
// A blob can belong to several offline targets at once (a song that lives on
// an album the user marked offline AND in a playlist they also marked
// offline). Membership is tracked via the multi-entry `EntityKeys` array on
// each blob row; eviction by entity only deletes the underlying blob once no
// target references it anymore.

import type { MediaBlobBackend } from './backends/types';
import type { LibraryCacheDb } from './db';
import type {
    CachedMediaBlob,
    OfflineEntityType,
    OfflineKey,
    OfflineSourceTag,
    OfflineTargetRow,
    OfflineTargetStatus,
} from './types';

import { backendForRef, getActiveBackend } from './backends/active-backend';
import { refForRow, rowFieldsForRef } from './backends/types';
import { getActiveCacheDb } from './db';

const TAG = '[offline-media]';

export const blobKey = (serverId: string, songId: string): OfflineKey =>
    `${serverId}:${songId}` as OfflineKey;

export const targetKey = (
    serverId: string,
    entityType: OfflineEntityType,
    entityId: string,
): string => `${serverId}:${entityType}:${entityId}`;

/**
 * Map any persisted target Status string into the current state machine. Legacy
 * values (`idle`/`syncing`) and crash residue (`downloading`/`enumerating`)
 * become `queued` so the manager resumes them; settled states pass through;
 * unknown values default to `queued`. Read-time only — never written back
 * destructively (the manager patches on resume).
 */
export const normalizeTargetStatus = (raw: string): OfflineTargetStatus => {
    switch (raw) {
        case 'complete':
        case 'error':
        case 'partial':
        case 'paused':
        case 'queued':
            return raw;
        default:
            // idle, syncing, downloading, enumerating, or anything unknown.
            return 'queued';
    }
};

// Map a Jellyfin container/extension hint to an audio MIME type. The web-audio
// engine reads the blob's `type`, so a correct MIME lets it pick the right
// decoder. Unknown containers fall back to a generic audio type — the browser
// usually still sniffs the bytes.
const CONTAINER_MIME: Record<string, string> = {
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    m4b: 'audio/mp4',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    webm: 'audio/webm',
};

export const mimeForContainer = (container: string | undefined): string => {
    if (!container) return 'audio/mpeg';
    return CONTAINER_MIME[container.toLowerCase()] ?? 'audio/mpeg';
};

export interface SaveMediaArgs {
    blob: Blob;
    container: string | undefined;
    entityKey: string;
    serverId: string;
    songId: string;
    // Freshness fingerprint stored on the new blob row; drives change detection
    // on later re-syncs (see cache/offline/dedup.ts). Not applied to a dedup hit.
    sourceTag?: OfflineSourceTag;
}

type DbGetter = () => LibraryCacheDb | undefined;

/**
 * Request persistent storage once so the browser is less likely to evict the
 * offline media under storage pressure. Best-effort: not all platforms grant
 * it and that's fine — IndexedDB still works, it's just evictable.
 */
let persistRequested = false;
export const requestPersistentStorage = async (): Promise<boolean> => {
    if (persistRequested) return true;
    persistRequested = true;
    try {
        if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
            const granted = await navigator.storage.persist();
            console.info(`${TAG} persistent storage ${granted ? 'granted' : 'denied'}`);
            return granted;
        }
    } catch (err) {
        console.warn(`${TAG} persistent storage request failed`, err);
    }
    return false;
};

export class LocalMediaStore {
    private readonly getBackend: () => MediaBlobBackend;
    private readonly getDb: DbGetter;

    // `getBackend` is injectable so tests can drive the streaming path against a
    // fake backend; production defaults to the platform's active backend.
    constructor(getDb: DbGetter = getActiveCacheDb, getBackend = getActiveBackend) {
        this.getDb = getDb;
        this.getBackend = getBackend;
    }

    /**
     * Append an entity key to an existing blob's membership without touching its
     * bytes. Used by the download pipeline's dedup path: a song already on disk
     * (for this or another target) only gains a reference. No-op if the blob is
     * absent or already references the entity.
     */
    async addEntityMembership(serverId: string, songId: string, entityKey: string): Promise<void> {
        const db = this.db();
        const row = await db.mediaBlobs.get(blobKey(serverId, songId));
        if (!row) return;
        if (!row.EntityKeys.includes(entityKey)) {
            row.EntityKeys.push(entityKey);
            await db.mediaBlobs.put(row);
        }
    }

    /** Wipe every offline blob AND every target. */
    async clearAll(): Promise<void> {
        const db = this.db();
        // Reclaim filesystem-backed bytes before dropping metadata so SD-card
        // files aren't orphaned. Only scan when the filesystem backend is
        // active — idb rows have no external bytes, and scanning them would
        // clone every audio blob into the heap (the documented OOM hazard).
        if (getActiveBackend().id === 'capacitor-fs') {
            const rows = await db.mediaBlobs.toArray();
            for (const row of rows) await this.reclaimBytes(row);
        }
        await db.mediaBlobs.clear();
        await db.offlineTargets.clear();
        console.info(`${TAG} cleared all offline media`);
    }

    // --- blob CRUD -------------------------------------------------------

    /** Number of distinct downloaded songs. */
    async count(): Promise<number> {
        const db = this.dbOrUndefined();
        if (!db) return 0;
        try {
            return await db.mediaBlobs.count();
        } catch (err) {
            console.warn(`${TAG} count() failed`, err);
            return 0;
        }
    }

    /** Delete a single song's blob outright (ignores entity membership). */
    async delete(serverId: string, songId: string): Promise<void> {
        const db = this.db();
        const key = blobKey(serverId, songId);
        const row = await db.mediaBlobs.get(key);
        if (row) await this.reclaimBytes(row);
        await db.mediaBlobs.delete(key);
    }

    /**
     * Delete a single song's blob row and reclaim its backing bytes. Used by the
     * download pipeline to discard a just-streamed track that turned out to blow
     * the storage cap (we can't know a streamed file's exact size until it's
     * written). Best-effort byte reclaim; the row removal is authoritative.
     */
    async deleteBlobBytes(serverId: string, songId: string): Promise<void> {
        const db = this.db();
        const key = blobKey(serverId, songId);
        const row = await db.mediaBlobs.get(key);
        if (!row) return;
        await this.reclaimBytes(row);
        await db.mediaBlobs.delete(key);
    }

    /**
     * Drop an offline-target's claim on its blobs. Blobs still referenced by
     * another target keep their bytes; blobs that were only held by this
     * target are deleted. Returns the number of bytes actually reclaimed.
     */
    async deleteEntity(entityKey: string): Promise<number> {
        const db = this.db();
        const rows = await db.mediaBlobs.where('EntityKeys').equals(entityKey).toArray();
        let reclaimed = 0;
        for (const row of rows) {
            const remaining = row.EntityKeys.filter((k) => k !== entityKey);
            if (remaining.length === 0) {
                reclaimed += row.ByteSize;
                await this.reclaimBytes(row);
                await db.mediaBlobs.delete(row.Key);
            } else {
                row.EntityKeys = remaining;
                await db.mediaBlobs.put(row);
            }
        }
        return reclaimed;
    }

    /** Fetch the stored blob for a song, or undefined when absent. */
    async get(serverId: string, songId: string): Promise<CachedMediaBlob | undefined> {
        const db = this.dbOrUndefined();
        if (!db) return undefined;
        try {
            return await db.mediaBlobs.get(blobKey(serverId, songId));
        } catch (err) {
            console.warn(`${TAG} get() failed`, err);
            return undefined;
        }
    }

    async getTarget(key: string): Promise<OfflineTargetRow | undefined> {
        const db = this.dbOrUndefined();
        if (!db) return undefined;
        try {
            return await db.offlineTargets.get(key);
        } catch (err) {
            console.warn(`${TAG} getTarget() failed`, err);
            return undefined;
        }
    }

    /** Whether a downloaded blob exists for this song. Cheap key lookup. */
    async has(serverId: string, songId: string): Promise<boolean> {
        const db = this.dbOrUndefined();
        if (!db) return false;
        try {
            const row = await db.mediaBlobs.get(blobKey(serverId, songId));
            // A downloaded song has bytes either inline (idb) or in a file (fs).
            return Boolean(row?.Blob || row?.Path);
        } catch (err) {
            console.warn(`${TAG} has() failed`, err);
            return false;
        }
    }

    /**
     * Every offline-target key that currently owns at least one downloaded
     * blob. Used to drive the entity-level "available offline" indicator
     * (an album/playlist/artist/genre reads as available once any of its
     * songs is on disk). Cheap: walks blob index keys only, no blob bytes.
     */
    async listAvailableEntityKeys(): Promise<string[]> {
        const db = this.dbOrUndefined();
        if (!db) return [];
        try {
            // Read the multi-entry `*EntityKeys` index keys directly instead of
            // iterating full rows. `.each()` structured-clones every row —
            // INCLUDING its audio `Blob` — just to read the scalar membership
            // array; on a multi-GB offline library that transiently
            // materialises the entire corpus into the JS heap (a real iOS OOM,
            // and this path runs on every availability refresh). The
            // `*EntityKeys` multiEntry index (see db.ts v9 schema) lets
            // IndexedDB hand back ONE key per array element across all rows
            // without touching the row store. Mirrors `sumThumbnailBytes` in
            // eviction.ts. We dedup into a Set exactly as before — multiEntry
            // keys repeat when the same entity key tags several blobs.
            const indexKeys = await db.mediaBlobs.orderBy('EntityKeys').keys();
            const keys = new Set<string>();
            for (const k of indexKeys) {
                if (typeof k === 'string') keys.add(k);
            }
            return [...keys];
        } catch (err) {
            console.warn(`${TAG} listAvailableEntityKeys() failed`, err);
            return [];
        }
    }

    /** Every blob row that belongs to the given offline-target key. */
    async listByEntity(entityKey: string): Promise<CachedMediaBlob[]> {
        const db = this.dbOrUndefined();
        if (!db) return [];
        try {
            return await db.mediaBlobs.where('EntityKeys').equals(entityKey).toArray();
        } catch (err) {
            console.warn(`${TAG} listByEntity() failed`, err);
            return [];
        }
    }

    /**
     * Every downloaded blob's `${serverId}:${songId}` key. Drives the
     * song-level "available offline" indicator. Cheap primary-key scan.
     */
    async listSongKeys(): Promise<string[]> {
        const db = this.dbOrUndefined();
        if (!db) return [];
        try {
            // `Key` is the primary key (`${serverId}:${songId}`), so reading
            // the primary-key cursor returns exactly what `.each()` pushed from
            // `row.Key` — but without structured-cloning each row's audio Blob
            // into the heap. See `listAvailableEntityKeys` for why the row-walk
            // is an OOM hazard on a large offline library.
            const indexKeys = await db.mediaBlobs.orderBy('Key').keys();
            const out: string[] = [];
            for (const k of indexKeys) {
                if (typeof k === 'string') out.push(k);
            }
            return out;
        } catch (err) {
            console.warn(`${TAG} listSongKeys() failed`, err);
            return [];
        }
    }

    async listTargets(): Promise<OfflineTargetRow[]> {
        const db = this.dbOrUndefined();
        if (!db) return [];
        try {
            const rows = await db.offlineTargets.toArray();
            return rows.sort((a, b) => a.AddedAt - b.AddedAt);
        } catch (err) {
            console.warn(`${TAG} listTargets() failed`, err);
            return [];
        }
    }

    /**
     * Materialize a row's audio bytes via whichever backend owns them. Returns
     * undefined for rows whose bytes are missing (e.g. an fs row whose volume
     * is absent).
     */
    async loadBlob(row: CachedMediaBlob): Promise<Blob | undefined> {
        const ref = refForRow(row);
        if (!ref) return undefined;
        return backendForRef(ref).load(ref);
    }

    // --- offline targets -------------------------------------------------

    async patchTarget(key: string, patch: Partial<OfflineTargetRow>): Promise<void> {
        const db = this.db();
        const existing = await db.offlineTargets.get(key);
        if (!existing) return;
        await db.offlineTargets.put({ ...existing, ...patch, UpdatedAt: Date.now() });
    }

    async putTarget(row: OfflineTargetRow): Promise<void> {
        const db = this.db();
        await db.offlineTargets.put(row);
    }

    /**
     * Remove a target and reclaim any blobs it solely owned. Returns reclaimed
     * bytes.
     */
    async removeTarget(key: string): Promise<number> {
        const db = this.db();
        const reclaimed = await this.deleteEntity(key);
        await db.offlineTargets.delete(key);
        console.info(`${TAG} removed target`, { key, reclaimed });
        return reclaimed;
    }

    /**
     * A directly-loadable URL for a row's bytes when the backend can provide
     * one (filesystem → convertFileSrc). Undefined on the idb backend, whose
     * consumers mint an object URL from `loadBlob` instead.
     */
    resolveUrl(row: CachedMediaBlob): string | undefined {
        const ref = refForRow(row);
        if (!ref) return undefined;
        return backendForRef(ref).resolveUrl?.(ref);
    }

    /**
     * Save (or merge into) the blob for a song. If the song was already
     * downloaded for a different target, the new entity key is appended to
     * `EntityKeys` rather than re-downloading. Returns true when a NEW blob
     * was written (so callers can attribute byte/count deltas), false when an
     * existing blob simply gained another entity reference.
     */
    async save(args: SaveMediaArgs): Promise<boolean> {
        const { blob, container, entityKey, serverId, songId, sourceTag } = args;
        const db = this.db();
        const key = blobKey(serverId, songId);
        const existing = await db.mediaBlobs.get(key);
        if (existing) {
            // Already have the bytes — just record the new membership. The
            // existing SourceTag is authoritative (it describes the bytes on
            // disk); a dedup caller's tag must not overwrite it.
            if (!existing.EntityKeys.includes(entityKey)) {
                existing.EntityKeys.push(entityKey);
                await db.mediaBlobs.put(existing);
            }
            return false;
        }
        const ref = await this.getBackend().store('audio', key, blob);
        const row: CachedMediaBlob = {
            ByteSize: blob.size,
            Container: container,
            DownloadedAt: Date.now(),
            EntityKeys: [entityKey],
            Key: key,
            MimeType: mimeForContainer(container),
            ServerId: serverId,
            SongId: songId,
            SourceTag: sourceTag,
            ...rowFieldsForRef(ref),
        };
        await db.mediaBlobs.put(row);
        return true;
    }

    /**
     * Streaming twin of {@link save}: dedups FIRST (an already-downloaded song
     * only gains a membership reference — no network at all), else streams the
     * URL's bytes straight to backing storage via the backend and records the
     * row. Returns whether a NEW blob was written and its real byte size (0 for
     * a dedup hit that touched nothing new). Only valid when
     * {@link supportsStreaming} is true.
     */
    async saveStreamed(args: {
        container: string | undefined;
        entityKey: string;
        serverId: string;
        signal?: AbortSignal;
        songId: string;
        sourceTag?: OfflineSourceTag;
        url: string;
    }): Promise<{ isNew: boolean; size: number }> {
        const { container, entityKey, serverId, signal, songId, sourceTag, url } = args;
        const db = this.db();
        const key = blobKey(serverId, songId);
        const existing = await db.mediaBlobs.get(key);
        if (existing) {
            if (!existing.EntityKeys.includes(entityKey)) {
                existing.EntityKeys.push(entityKey);
                await db.mediaBlobs.put(existing);
            }
            return { isNew: false, size: existing.ByteSize };
        }
        const backend = this.getBackend();
        if (!backend.storeFromUrl) {
            throw new Error(`${TAG} active backend cannot stream from url`);
        }
        const { ref, size } = await backend.storeFromUrl('audio', key, url, { signal });
        const row: CachedMediaBlob = {
            ByteSize: size,
            Container: container,
            DownloadedAt: Date.now(),
            EntityKeys: [entityKey],
            Key: key,
            MimeType: mimeForContainer(container),
            ServerId: serverId,
            SongId: songId,
            SourceTag: sourceTag,
            ...rowFieldsForRef(ref),
        };
        await db.mediaBlobs.put(row);
        return { isNew: true, size };
    }

    async setTargetStatus(key: string, status: OfflineTargetStatus): Promise<void> {
        await this.patchTarget(key, { Status: status });
    }

    /**
     * True when the active backend can stream a URL straight to storage without
     * pulling the whole payload into the JS heap (Android filesystem backend).
     * The download pipeline uses this to pick the OOM-safe streaming path.
     */
    supportsStreaming(): boolean {
        return typeof this.getBackend().storeFromUrl === 'function';
    }

    /** Sum of every offline audio blob's byte size. */
    async totalBytes(): Promise<number> {
        const db = this.dbOrUndefined();
        if (!db) return 0;
        try {
            // Sum the `ByteSize` index keys — IndexedDB returns one integer per
            // row from the index without deserialising the row store (and so
            // without pulling the audio Blob into memory). Identical sum to the
            // old `.each((row) => total += row.ByteSize)` walk, but O(1) heap
            // instead of O(corpus bytes). Mirrors `sumThumbnailBytes` in
            // eviction.ts. (Rows persisted with a missing/undefined ByteSize
            // produced an index entry of `undefined`, which the old code
            // coalesced to 0; the cursor simply skips non-numeric keys, giving
            // the same total.)
            const indexKeys = await db.mediaBlobs.orderBy('ByteSize').keys();
            let total = 0;
            for (const k of indexKeys) {
                if (typeof k === 'number') total += k;
            }
            return total;
        } catch (err) {
            console.warn(`${TAG} totalBytes() failed`, err);
            return 0;
        }
    }

    private db(): LibraryCacheDb {
        const db = this.getDb();
        if (!db) throw new Error(`${TAG} no active cache DB`);
        return db;
    }

    private dbOrUndefined(): LibraryCacheDb | undefined {
        return this.getDb();
    }

    /** Reclaim a row's backing bytes (deletes the file on the fs backend). */
    private async reclaimBytes(row: CachedMediaBlob): Promise<void> {
        const ref = refForRow(row);
        if (ref) await backendForRef(ref).remove(ref);
    }
}

// Shared singleton used everywhere except tests (which construct their own
// LocalMediaStore against a mock DB getter).
export const localMediaStore = new LocalMediaStore();
