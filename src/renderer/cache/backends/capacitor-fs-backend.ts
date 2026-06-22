import { Capacitor } from '@capacitor/core';

import type { BlobNamespace, BlobRef, MediaBlobBackend } from './types';
import type { VolumeInfo } from './volumes';

import { MediaVolumes } from './volumes';

const TAG = '[media-backend]';
const ROOT_DIR = 'feishin-cache';

// Base64-encode a blob for the native writeFile bridge. Uses
// FileReader.readAsDataURL, which runs the encode in native (Chromium) code OFF
// the JS main thread. The previous `String.fromCharCode(...) + btoa` loop
// encoded every multi-megabyte audio file synchronously on the main thread —
// hundreds of ms per file — which froze the UI (ANR on low-end devices) and
// slowed downloads on every device. We strip the `data:<mime>;base64,` prefix.
export const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error('FileReader read failed'));
        reader.readAsDataURL(blob);
    });

export const base64ToBlob = (b64: string): Blob => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes]);
};

// Sanitize a blob key (`serverId:songId`) into a filesystem-safe leaf.
const safeLeaf = (key: string): string => key.replace(/[^a-zA-Z0-9._-]/g, '_');

export const pathFor = (root: string, ns: BlobNamespace, key: string): string =>
    `${root}/${ROOT_DIR}/${ns}/${safeLeaf(key)}`;

// Capacitor filesystem backend: bytes live in a file under the active volume's
// app-specific external dir. The Dexie row keeps only a Path. Writes and
// non-playback reads cross the bridge as base64; PLAYBACK reads use resolveUrl
// (Capacitor.convertFileSrc) so bytes never enter the JS heap on the hot path.
export class CapacitorFsBackend implements MediaBlobBackend {
    readonly id = 'capacitor-fs' as const;

    private readonly getVolume: () => undefined | VolumeInfo;

    constructor(getVolume: () => undefined | VolumeInfo) {
        this.getVolume = getVolume;
    }

    async health(): Promise<{ available: boolean }> {
        return { available: Boolean(this.getVolume()) };
    }

    async load(ref: BlobRef): Promise<Blob | undefined> {
        if (ref.kind !== 'fs') return undefined;
        try {
            const { dataBase64 } = await MediaVolumes.readFile({ path: ref.path });
            return base64ToBlob(dataBase64);
        } catch (err) {
            console.warn(`${TAG} fs load failed`, ref.path, err);
            return undefined;
        }
    }

    async remove(ref: BlobRef): Promise<void> {
        if (ref.kind !== 'fs') return;
        try {
            await MediaVolumes.deleteFile({ path: ref.path });
        } catch (err) {
            console.warn(`${TAG} fs remove failed`, ref.path, err);
        }
    }

    resolveUrl(ref: BlobRef): string | undefined {
        return ref.kind === 'fs' ? Capacitor.convertFileSrc(ref.path) : undefined;
    }

    async store(ns: BlobNamespace, key: string, blob: Blob): Promise<BlobRef> {
        const volume = this.getVolume();
        if (!volume) throw new Error(`${TAG} no active fs volume`);
        const path = pathFor(volume.path, ns, key);
        const dataBase64 = await blobToBase64(blob);
        await MediaVolumes.writeFile({ dataBase64, path });
        return { kind: 'fs', path, volumeId: volume.id };
    }
}
