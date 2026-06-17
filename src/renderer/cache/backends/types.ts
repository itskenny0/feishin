// MediaBlobBackend — the pluggable byte-storage backend for the offline cache.
//
// The LocalMediaStore / images layer owns the Dexie *metadata* rows; a backend
// owns where the actual *bytes* live and hands back a `BlobRef` the row carries.
// Two backends exist:
//   - IndexedDbBackend  — bytes live inline in the Dexie row (web/Electron/iOS,
//     and the universal fallback). This is the historical behavior.
//   - CapacitorFsBackend — bytes live in a file under a chosen Android volume
//     (internal storage or a removable SD card); the row stores a file `Path`.
//
// Keeping metadata in Dexie means every existing index-key optimization
// (totalBytes via ByteSize, listSongKeys, eviction sums, entity membership)
// keeps working untouched — only the bytes move off IndexedDB.

export type BlobNamespace = 'audio' | 'image';

export type BlobRef =
    | { blob: Blob; kind: 'idb' }
    | { kind: 'fs'; path: string; volumeId: string };

export interface MediaBlobBackend {
    readonly id: 'capacitor-fs' | 'idb';
    /** Is the underlying store reachable right now? (SD card present/mounted.) */
    health(): Promise<{ available: boolean }>;
    /** Materialize the bytes for a ref, or undefined when missing/wrong-backend. */
    load(ref: BlobRef): Promise<Blob | undefined>;
    /** Reclaim the bytes for a ref. No-op for the idb backend (row deletion does it). */
    remove(ref: BlobRef): Promise<void>;
    /**
     * A WebView-loadable URL for direct media playback / <img>, when the backend
     * can provide one (FS → Capacitor.convertFileSrc). Undefined for idb, whose
     * consumers mint object URLs from the loaded blob instead.
     */
    resolveUrl?(ref: BlobRef): string | undefined;
    /** Persist bytes and return the ref the metadata row should carry. */
    store(ns: BlobNamespace, key: string, blob: Blob): Promise<BlobRef>;
}

interface RowRefFields {
    Backend?: 'capacitor-fs' | 'idb';
    Blob?: Blob;
    Path?: string;
    VolumeId?: string;
}

/** Translate a backend ref into the Dexie row fields that persist it. */
export const rowFieldsForRef = (ref: BlobRef): RowRefFields =>
    ref.kind === 'idb'
        ? { Backend: 'idb', Blob: ref.blob }
        : { Backend: 'capacitor-fs', Path: ref.path, VolumeId: ref.volumeId };

/**
 * Recover a backend ref from a stored row. Legacy rows (written before the
 * pluggable backend) carry only an inline `Blob` and no `Backend` tag — they
 * read as idb refs.
 */
export const refForRow = (row: RowRefFields): BlobRef | undefined => {
    if (row.Backend === 'capacitor-fs' || (row.Path && !row.Blob)) {
        if (!row.Path) return undefined;
        return { kind: 'fs', path: row.Path, volumeId: row.VolumeId ?? 'internal' };
    }
    if (row.Blob) return { blob: row.Blob, kind: 'idb' };
    return undefined;
};
