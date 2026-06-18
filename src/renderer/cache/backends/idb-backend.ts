import type { BlobNamespace, BlobRef, MediaBlobBackend } from './types';

const TAG = '[media-backend]';

// IndexedDB backend: bytes live inline in the Dexie row, exactly as before the
// pluggable backend landed. store() just wraps the blob; the LocalMediaStore /
// images layer persists the row. This is the universal backend for
// web/Electron/iOS and the fallback on Android.
export class IndexedDbBackend implements MediaBlobBackend {
    readonly id = 'idb' as const;

    async health(): Promise<{ available: boolean }> {
        return { available: true };
    }

    async load(ref: BlobRef): Promise<Blob | undefined> {
        return ref.kind === 'idb' ? ref.blob : undefined;
    }

    async remove(_ref: BlobRef): Promise<void> {
        // Bytes are reclaimed when the Dexie row is deleted; nothing to do here.
    }

    async store(_ns: BlobNamespace, _key: string, blob: Blob): Promise<BlobRef> {
        return { blob, kind: 'idb' };
    }
}

export const idbBackend = new IndexedDbBackend();
console.info(`${TAG} idb backend ready`);
