// Blob migration engine. Moves the bytes of every offline-audio + cached-image
// row from wherever they currently live to a target backend (e.g. IndexedDB →
// SD-card filesystem on a volume switch, or the reverse), rewriting each Dexie
// row's ref in place and reclaiming the source bytes. Also `startFresh`, which
// drops all bytes and re-arms the offline targets for re-download.
//
// The engine is idempotent and resumable: a row already at the target is
// skipped, so a re-run after an interruption only finishes what's left. A
// per-row load/store failure is counted and skipped, never aborting the run.

import type { LibraryCacheDb } from '../db';
import type { CachedMediaBlob, CachedThumbnail } from '../types';
import type { BlobNamespace, BlobRef, MediaBlobBackend } from './types';

import { getActiveCacheDb } from '../db';
import { backendForRef } from './active-backend';
import { refForRow, rowFieldsForRef } from './types';

const TAG = '[media-backend]';

export interface MigrateOptions {
    db?: LibraryCacheDb;
    onProgress?: (p: MigrateProgress) => void;
    signal?: AbortSignal;
    /** Destination backend for the bytes. */
    to: MediaBlobBackend;
    /** Volume id the destination writes to (for the fs backend). Null/undefined
     *  for the idb backend. Used only to decide which rows are already at the
     *  target and can be skipped. */
    toVolumeId?: null | string;
}

export interface MigrateProgress {
    bytes: number;
    items: number;
    totalBytes: number;
    totalItems: number;
}

export interface MigrateResult {
    failed: number;
    migrated: number;
}

// Is a row's current ref already at the migration target? idb target ⇒ inline
// blob; fs target ⇒ a file on the SAME volume we're migrating to.
const isAtTarget = (ref: BlobRef, to: MediaBlobBackend, toVolumeId?: null | string): boolean => {
    if (to.id === 'idb') return ref.kind === 'idb';
    return ref.kind === 'fs' && ref.volumeId === toVolumeId;
};

// Overwrite a row's ref-bearing fields cleanly: set the chosen backend's fields
// and clear the other backend's leftovers (e.g. a stale Path after fs→idb).
const writeRefFields = (
    row: CachedMediaBlob | CachedThumbnail,
    ref: BlobRef,
): CachedMediaBlob | CachedThumbnail => {
    const fields = rowFieldsForRef(ref);
    row.Backend = fields.Backend;
    row.Blob = fields.Blob;
    row.Path = fields.Path;
    row.VolumeId = fields.VolumeId;
    return row;
};

const thumbKey = (row: CachedThumbnail): string => `${row.ItemId}::${row.Variant}`;

/**
 * Migrate every audio + image blob to `to`. Returns counts of migrated and
 * failed rows. Negative-cache thumbnail markers (no bytes) are left untouched.
 */
export const migrateBlobs = async (opts: MigrateOptions): Promise<MigrateResult> => {
    const { onProgress, signal, to, toVolumeId } = opts;
    const db = opts.db ?? getActiveCacheDb();
    if (!db) return { failed: 0, migrated: 0 };

    const media = await db.mediaBlobs.toArray();
    const thumbs = await db.thumbnails.toArray();

    // Up-front totals (only rows that actually need moving) so the progress UI
    // can show a stable denominator.
    const pending: Array<{
        key: string;
        ns: BlobNamespace;
        ref: BlobRef;
        row: CachedMediaBlob | CachedThumbnail;
        table: 'mediaBlobs' | 'thumbnails';
    }> = [];
    for (const row of media) {
        const ref = refForRow(row);
        if (ref && !isAtTarget(ref, to, toVolumeId)) {
            pending.push({ key: row.Key, ns: 'audio', ref, row, table: 'mediaBlobs' });
        }
    }
    for (const row of thumbs) {
        const ref = refForRow(row);
        if (ref && !isAtTarget(ref, to, toVolumeId)) {
            pending.push({ key: thumbKey(row), ns: 'image', ref, row, table: 'thumbnails' });
        }
    }

    const totalItems = pending.length;
    const totalBytes = pending.reduce((sum, p) => sum + (p.row.ByteSize ?? 0), 0);
    let items = 0;
    let bytes = 0;
    let migrated = 0;
    let failed = 0;

    console.info(`${TAG} migrate start`, { to: to.id, totalBytes, totalItems, toVolumeId });

    for (const p of pending) {
        if (signal?.aborted) {
            console.info(`${TAG} migrate aborted`, { failed, migrated });
            break;
        }
        try {
            const blob = await backendForRef(p.ref).load(p.ref);
            if (!blob) {
                failed += 1;
                continue;
            }
            const newRef = await to.store(p.ns, p.key, blob);
            writeRefFields(p.row, newRef);
            if (p.table === 'mediaBlobs') {
                await db.mediaBlobs.put(p.row as CachedMediaBlob);
            } else {
                await db.thumbnails.put(p.row as CachedThumbnail);
            }
            await backendForRef(p.ref).remove(p.ref);
            migrated += 1;
        } catch (err) {
            failed += 1;
            console.warn(`${TAG} migrate row failed`, { key: p.key, table: p.table }, err);
        }
        items += 1;
        bytes += p.row.ByteSize ?? 0;
        onProgress?.({ bytes, items, totalBytes, totalItems });
    }

    console.info(`${TAG} migrate done`, { failed, migrated });
    return { failed, migrated };
};

/**
 * Drop every offline-audio + cached-image blob (reclaiming filesystem bytes via
 * each row's own backend) and re-arm offline targets for re-download. Used by
 * the "start fresh" choice on a volume switch / first-start migration.
 */
export const startFresh = async (opts?: { db?: LibraryCacheDb }): Promise<void> => {
    const db = opts?.db ?? getActiveCacheDb();
    if (!db) return;

    const media = await db.mediaBlobs.toArray();
    for (const row of media) {
        const ref = refForRow(row);
        if (ref) await backendForRef(ref).remove(ref);
    }
    const thumbs = await db.thumbnails.toArray();
    for (const row of thumbs) {
        const ref = refForRow(row);
        if (ref) await backendForRef(ref).remove(ref);
    }

    await db.mediaBlobs.clear();
    await db.thumbnails.clear();

    // Keep the offline targets but reset them to idle (with no downloaded
    // bytes) so the next sync re-downloads them into the now-active location.
    const targets = await db.offlineTargets.toArray();
    for (const t of targets) {
        await db.offlineTargets.put({
            ...t,
            Bytes: 0,
            DownloadedCount: 0,
            Status: 'idle',
            UpdatedAt: Date.now(),
        });
    }

    console.info(`${TAG} start-fresh complete`, { targets: targets.length });
};
