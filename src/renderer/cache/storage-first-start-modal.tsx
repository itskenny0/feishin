// StorageFirstStartModalHost — fires the one-time upgrade prompt offering to
// move an existing (IndexedDB) offline cache onto an SD card, or start fresh.
// Mounted once at the app root. It self-gates: Android only, cache enabled,
// the blob-backend version not yet stamped, something actually downloaded, and
// a removable volume present. Dismissing it stamps the version so it never
// nags again (the user can still switch later from Settings).

import { useEffect, useState } from 'react';

import type { VolumeInfo } from './backends/volumes';

import {
    FS_BACKEND_VERSION,
    markBlobBackendMigrated,
    refreshVolumes,
} from './backends/active-backend';
import { isAndroidNative } from './backends/volumes';
import { refreshOfflineStats } from './offline-media';
import { StorageMigrationModal } from './storage-migration-modal';
import { useCacheStore } from './store';

import { useSettingsStore } from '/@/renderer/store';

export const StorageFirstStartModalHost = () => {
    const cacheEnabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const backendVersion = useSettingsStore((s) => s.localCache?.android?.blobBackendVersion ?? 0);
    const stats = useCacheStore((s) => s.offlineMedia);

    const [target, setTarget] = useState<null | VolumeInfo>(null);
    const [decided, setDecided] = useState(false);

    const eligible =
        isAndroidNative() && cacheEnabled && backendVersion < FS_BACKEND_VERSION && !decided;

    useEffect(() => {
        if (!eligible) return;
        let cancelled = false;
        void (async () => {
            await refreshOfflineStats();
            const volumes = await refreshVolumes();
            if (cancelled) return;
            const sd = volumes.find((v) => v.removable);
            const downloaded = useCacheStore.getState().offlineMedia.itemsDownloaded;
            if (sd && downloaded > 0) {
                setTarget(sd);
            } else {
                // Nothing to migrate (or no SD card) — stamp so we don't re-check
                // on every launch.
                markBlobBackendMigrated();
                setDecided(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [eligible]);

    if (!eligible || !target) return null;

    return (
        <StorageMigrationModal
            itemCount={stats.itemsDownloaded}
            mode="first-start"
            onClose={() => {
                // Dismissed without migrating: stay on internal storage but stamp
                // the version so the prompt doesn't reappear next launch.
                markBlobBackendMigrated();
                setDecided(true);
                setTarget(null);
            }}
            opened={Boolean(target)}
            targetVolumeId={target.id}
            targetVolumeLabel={target.label}
            totalBytes={stats.bytesUsed}
        />
    );
};
