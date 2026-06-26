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
import { awaitActiveCacheDb } from './db';
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
            // Migrate to INTERNAL storage (always present). The win is moving the
            // cover-art bytes OFF IndexedDB into files — covers then render from a
            // native file URL with no IndexedDB blob read, so they paint instantly
            // even while the cache is busy at launch. (SD-card offline audio stays
            // a separate Settings choice.)
            const internal = volumes.find((v) => !v.removable) ?? volumes[0];
            // WAIT for the cache DB to actually open before probing. This host
            // mounts during the boot race; a bare getActiveCacheDb() returns
            // undefined too early, which false-negatives and stamps the version —
            // permanently suppressing the prompt. awaitActiveCacheDb resolves the
            // moment the DB opens (or after the timeout).
            const db = await awaitActiveCacheDb(15000);
            if (cancelled) return;
            if (!db) {
                // DB never opened this launch — leave the version UNstamped so a
                // future launch re-evaluates rather than suppressing forever.
                console.warn('[thumbs-migrate] cache DB not ready; deferring prompt');
                return;
            }
            // Any OLD-STYLE (inline-Blob) rows still in IndexedDB — cover art
            // (usually the bulk) or audio? The first match short-circuits the
            // scan. We deliberately do NOT trigger on "audio downloaded" alone —
            // an SD-card user is already on fs and must not be pulled to internal.
            let hasIdbBlob = false;
            try {
                hasIdbBlob =
                    Boolean(await db.thumbnails.filter((r) => Boolean(r.Blob)).first()) ||
                    Boolean(await db.mediaBlobs.filter((r) => Boolean(r.Blob)).first());
            } catch (err) {
                console.warn('[thumbs-migrate] idb probe failed', err);
            }
            if (cancelled) return;
            console.info('[thumbs-migrate] eligibility', {
                hasIdbBlob,
                internal: internal?.id,
                volumeCount: volumes.length,
            });
            if (internal && hasIdbBlob) {
                setTarget(internal);
            } else {
                // Nothing old-style to migrate (fresh install / already on fs) —
                // stamp so we don't re-check on every launch.
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
