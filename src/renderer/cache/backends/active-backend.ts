import type { BlobRef, MediaBlobBackend } from './types';
import type { VolumeInfo } from './volumes';

import { useCacheStore } from '../store';
import { CapacitorFsBackend } from './capacitor-fs-backend';
import { idbBackend } from './idb-backend';
import { isAndroidNative, listVolumes } from './volumes';

import { useSettingsStore } from '/@/renderer/store';

const TAG = '[media-backend]';

// Bumped whenever the Android default byte storage changes in a way that needs
// existing IndexedDB-cached installs to migrate. The first-startup migration
// modal fires while localCache.android.blobBackendVersion < this.
//   v1: offline-audio bytes movable to an SD-card volume.
//   v2: cover-art bytes move off IndexedDB onto the filesystem so covers render
//       from a native file URL (convertFileSrc) with no IndexedDB blob read.
//   v3: re-migrate covers that landed back in IndexedDB. The active backend
//       only chose the filesystem when `storageVolumeId` was explicitly set;
//       with it null (the default), every write fell through to the slow idb
//       backend, so covers cached after v2 (e.g. a new/large server) were blob
//       rows again. v3 defaults Android to the internal volume + re-migrates.
export const FS_BACKEND_VERSION = 3;

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

// The internal (non-removable) volume — Android's app/private storage, always
// present. Used as the default target so cover/byte writes go to the fast
// filesystem backend instead of falling back to IndexedDB blobs.
const getInternalVolume = (): undefined | VolumeInfo =>
    volumes.find((v) => !v.removable) ?? volumes[0];

export const getActiveVolume = (): undefined | VolumeInfo => {
    const id = configuredVolumeId();
    if (id) return volumes.find((v) => v.id === id);
    // No volume explicitly configured: on Android default to the internal
    // volume so the filesystem backend (file-URL covers) is used rather than
    // the slow IndexedDB-blob fallback. (The on-device benchmark put fs ~5-6x
    // faster than idb for cover reads.)
    if (isAndroidNative()) return getInternalVolume();
    return undefined;
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
    // Android native always uses the filesystem backend (defaulting to the
    // internal volume via getActiveVolume) so covers/bytes are stored as files
    // and read back as instant file URLs. Only when no volume can be resolved
    // at all (volumes not yet enumerated) do we fall back to idb.
    if (isAndroidNative() && getActiveVolume()) return fsBackend;
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
            backgroundSync: current?.backgroundSync ?? true,
            blobBackendVersion: current?.blobBackendVersion ?? 0,
            storageOnboarded: current?.storageOnboarded ?? false,
            storageRootPath: root,
            storageVolumeId: volumeId,
        },
    });
    console.info(`${TAG} active volume set`, { root, volumeId });
};

/**
 * Re-enumerate volumes and push the active backend's health into the cache
 * store's `volumeAvailable` flag. Call on boot and on app resume so a removed/
 * reinserted SD card flips the offline-availability gate + banner. Returns the
 * resolved availability.
 */
export const reconcileVolumeHealth = async (): Promise<boolean> => {
    await refreshVolumes();
    const { available } = await getActiveBackend().health();
    useCacheStore.getState().actions.setVolumeAvailable(available);
    console.info(`${TAG} volume health`, { available });
    return available;
};

export const markBlobBackendMigrated = (): void => {
    const current = androidSlice();
    useSettingsStore.getState().actions.setLocalCache({
        android: {
            backgroundSync: current?.backgroundSync ?? true,
            blobBackendVersion: FS_BACKEND_VERSION,
            storageRootPath: current?.storageRootPath ?? null,
            storageVolumeId: current?.storageVolumeId ?? null,
        },
    });
};
