import type { BlobRef, MediaBlobBackend } from './types';
import type { VolumeInfo } from './volumes';

import { CapacitorFsBackend } from './capacitor-fs-backend';
import { idbBackend } from './idb-backend';
import { isAndroidNative, listVolumes } from './volumes';

import { useSettingsStore } from '/@/renderer/store';

const TAG = '[media-backend]';

// Bumped whenever the Android default byte storage changes in a way that needs
// existing IndexedDB-cached installs to migrate. The first-startup migration
// modal fires while localCache.android.blobBackendVersion < this.
export const FS_BACKEND_VERSION = 1;

// Last enumerated volume list. Refreshed on boot / app resume / when the
// settings picker opens; getActiveVolume resolves the configured id against it.
let volumes: VolumeInfo[] = [];

export const refreshVolumes = async (): Promise<VolumeInfo[]> => {
    volumes = await listVolumes();
    return volumes;
};

export const getKnownVolumes = (): VolumeInfo[] => volumes;

const androidSlice = () => useSettingsStore.getState().localCache?.android;

const configuredVolumeId = (): null | string => androidSlice()?.storageVolumeId ?? null;

export const getActiveVolume = (): undefined | VolumeInfo => {
    const id = configuredVolumeId();
    if (!id) return undefined;
    return volumes.find((v) => v.id === id);
};

const fsBackend = new CapacitorFsBackend(getActiveVolume);

/**
 * The backend that owns byte storage right now. The Capacitor filesystem
 * backend is used on Android once a non-null volume is configured — even when
 * that volume is currently absent (card removed), so reads attempt and fail
 * gracefully and health() reports unavailable to drive the Task 10 banner.
 * Everywhere else (web, Electron, iOS, or Android with no volume chosen) the
 * IndexedDB backend is used.
 */
export const getActiveBackend = (): MediaBlobBackend => {
    if (isAndroidNative() && configuredVolumeId()) return fsBackend;
    return idbBackend;
};

/**
 * The backend that owns an EXISTING ref's bytes, chosen by the ref's kind —
 * not by the active selection. After a volume switch (or a partial migration)
 * fs- and idb-backed rows coexist, so load/resolveUrl/remove must dispatch on
 * the row itself. New writes still go through getActiveBackend().store.
 */
export const backendForRef = (ref: BlobRef): MediaBlobBackend =>
    ref.kind === 'fs' ? fsBackend : idbBackend;

export const setActiveVolume = async (volumeId: null | string): Promise<void> => {
    const root = volumeId ? (volumes.find((v) => v.id === volumeId)?.path ?? null) : null;
    const current = androidSlice();
    useSettingsStore.getState().actions.setLocalCache({
        android: {
            blobBackendVersion: current?.blobBackendVersion ?? 0,
            storageRootPath: root,
            storageVolumeId: volumeId,
        },
    });
    console.info(`${TAG} active volume set`, { root, volumeId });
};

export const markBlobBackendMigrated = (): void => {
    const current = androidSlice();
    useSettingsStore.getState().actions.setLocalCache({
        android: {
            blobBackendVersion: FS_BACKEND_VERSION,
            storageRootPath: current?.storageRootPath ?? null,
            storageVolumeId: current?.storageVolumeId ?? null,
        },
    });
};
