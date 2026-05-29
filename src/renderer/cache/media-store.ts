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

import type { LibraryCacheDb } from './db';
import type {
    CachedMediaBlob,
    OfflineEntityType,
    OfflineKey,
    OfflineTargetRow,
    OfflineTargetStatus,
} from './types';

import { getActiveCacheDb } from './db';

const TAG = '[offline-media]';

export const blobKey = (serverId: string, songId: string): OfflineKey =>
    `${serverId}:${songId}` as OfflineKey;

export const targetKey = (
    serverId: string,
    entityType: OfflineEntityType,
    entityId: string,
): string => `${serverId}:${entityType}:${entityId}`;

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
    private readonly getDb: DbGetter;

    constructor(getDb: DbGetter = getActiveCacheDb) {
        this.getDb = getDb;
    }

    /** Wipe every offline blob AND every target. */
    async clearAll(): Promise<void> {
        const db = this.db();
        await db.mediaBlobs.clear();
        await db.offlineTargets.clear();
        console.info(`${TAG} cleared all offline media`);
    }

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

    // --- blob CRUD -------------------------------------------------------

    /** Delete a single song's blob outright (ignores entity membership). */
    async delete(serverId: string, songId: string): Promise<void> {
        const db = this.db();
        await db.mediaBlobs.delete(blobKey(serverId, songId));
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
            return Boolean(row?.Blob);
        } catch (err) {
            console.warn(`${TAG} has() failed`, err);
            return false;
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

    // --- offline targets -------------------------------------------------

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
     * Save (or merge into) the blob for a song. If the song was already
     * downloaded for a different target, the new entity key is appended to
     * `EntityKeys` rather than re-downloading. Returns true when a NEW blob
     * was written (so callers can attribute byte/count deltas), false when an
     * existing blob simply gained another entity reference.
     */
    async save(args: SaveMediaArgs): Promise<boolean> {
        const { blob, container, entityKey, serverId, songId } = args;
        const db = this.db();
        const key = blobKey(serverId, songId);
        const existing = await db.mediaBlobs.get(key);
        if (existing) {
            // Already have the bytes — just record the new membership.
            if (!existing.EntityKeys.includes(entityKey)) {
                existing.EntityKeys.push(entityKey);
                await db.mediaBlobs.put(existing);
            }
            return false;
        }
        const row: CachedMediaBlob = {
            Blob: blob,
            ByteSize: blob.size,
            Container: container,
            DownloadedAt: Date.now(),
            EntityKeys: [entityKey],
            Key: key,
            MimeType: mimeForContainer(container),
            ServerId: serverId,
            SongId: songId,
        };
        await db.mediaBlobs.put(row);
        return true;
    }

    async setTargetStatus(key: string, status: OfflineTargetStatus): Promise<void> {
        await this.patchTarget(key, { Status: status });
    }

    /** Sum of every offline audio blob's byte size. */
    async totalBytes(): Promise<number> {
        const db = this.dbOrUndefined();
        if (!db) return 0;
        try {
            let total = 0;
            await db.mediaBlobs.each((row) => {
                total += row.ByteSize ?? 0;
            });
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
}

// Shared singleton used everywhere except tests (which construct their own
// LocalMediaStore against a mock DB getter).
export const localMediaStore = new LocalMediaStore();
