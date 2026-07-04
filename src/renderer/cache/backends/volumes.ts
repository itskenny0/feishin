import { Capacitor, registerPlugin } from '@capacitor/core';

const TAG = '[media-volumes]';

export interface MediaVolumesPlugin {
    // Abort an in-flight downloadFile by its id: disconnects the native HTTP
    // connection, which unwinds the streaming copy and deletes the partial file.
    cancelDownload(o: { downloadId: string }): Promise<void>;
    deleteFile(o: { path: string }): Promise<void>;
    // Stream a URL's bytes straight to `path` in native code (no base64, no
    // bridge round-trip of the payload). `downloadId` lets cancelDownload abort
    // it. Resolves with the number of bytes written.
    downloadFile(o: { downloadId: string; path: string; url: string }): Promise<{ bytes: number }>;
    freeSpace(o: { path: string }): Promise<{ freeBytes: number; totalBytes: number }>;
    listVolumes(): Promise<{ volumes: VolumeInfo[] }>;
    mkdirp(o: { path: string }): Promise<void>;
    readFile(o: { path: string }): Promise<{ dataBase64: string }>;
    stat(o: { path: string }): Promise<{ exists: boolean; size: number }>;
    writeFile(o: { dataBase64: string; path: string }): Promise<void>;
}

export interface VolumeInfo {
    freeBytes: number;
    id: string;
    label: string;
    path: string;
    removable: boolean;
    totalBytes: number;
}

// The native plugin lives in android/.../MediaVolumesPlugin.java. On other
// platforms registerPlugin returns a proxy that rejects on call — guarded by
// isAndroidNative() before every use.
export const MediaVolumes = registerPlugin<MediaVolumesPlugin>('MediaVolumes');

export const isAndroidNative = (): boolean =>
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const listVolumes = async (): Promise<VolumeInfo[]> => {
    if (!isAndroidNative()) return [];
    try {
        const { volumes } = await MediaVolumes.listVolumes();
        console.info(
            `${TAG} volumes`,
            volumes.map((v) => `${v.id}:${v.path}`),
        );
        return volumes;
    } catch (err) {
        console.warn(`${TAG} listVolumes failed`, err);
        return [];
    }
};
