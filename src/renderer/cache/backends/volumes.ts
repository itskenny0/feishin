import { Capacitor, registerPlugin } from '@capacitor/core';

const TAG = '[media-volumes]';

export interface MediaVolumesPlugin {
    deleteFile(o: { path: string }): Promise<void>;
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
