// Pre-sync storage-location choice. Shown by the SyncGate on Android BEFORE the
// first sync starts (the sync runner only mounts once this step is dismissed via
// "Start sync"), so the user picks where the offline library lives before any
// bytes are written. Non-Android platforms never see this — `isAndroidNative()`
// is false there and the gate renders the dashboard directly.

import type { VolumeInfo } from '/@/renderer/cache/backends/volumes';

import { Button, Select, Stack } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './sync-dashboard.module.css';

import { refreshVolumes } from '/@/renderer/cache/backends/active-backend';
import { formatBytes } from '/@/renderer/cache/format';
import { StorageMigrationModal } from '/@/renderer/cache/storage-migration-modal';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const INTERNAL = '__internal__';

interface StorageChoiceStepProps {
    onStart: () => void;
}

export const StorageChoiceStep = ({ onStart }: StorageChoiceStepProps) => {
    const { t } = useTranslation();
    const configuredId = useSettingsStore((s) => s.localCache?.android?.storageVolumeId ?? null);
    const stats = useCacheStore((s) => s.offlineMedia);

    const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
    const [pending, setPending] = useState<null | { id: null | string; label: string }>(null);

    useEffect(() => {
        void refreshVolumes().then(setVolumes);
    }, []);

    const handleChange = useCallback(
        (value: null | string) => {
            const targetId = value === INTERNAL ? null : value;
            if (targetId === configuredId) return;
            const label =
                targetId === null
                    ? t('page.setting.storageLocation.internal', {
                          defaultValue: 'Internal storage',
                      })
                    : (volumes.find((v) => v.id === targetId)?.label ?? targetId);
            setPending({ id: targetId, label });
        },
        [configuredId, t, volumes],
    );

    const options = [
        {
            label: t('page.setting.storageLocation.internal', { defaultValue: 'Internal storage' }),
            value: INTERNAL,
        },
        ...volumes
            .filter((v) => v.removable)
            .map((v) => ({
                label: `${v.label} · ${formatBytes(v.freeBytes)} ${t(
                    'page.setting.storageLocation.free',
                    { defaultValue: 'free' },
                )}`,
                value: v.id,
            })),
    ];

    return (
        <div className={styles.root}>
            <div className={styles.panel}>
                <p className={styles.eyebrow}>
                    {t('page.syncGate.storageEyebrow', { defaultValue: 'Local library' })}
                </p>
                <h1 className={styles.heading}>
                    {t('page.syncGate.storageHeading', {
                        defaultValue: 'Where should we store your library?',
                    })}
                </h1>
                <p className={styles.subheading}>
                    {t('page.syncGate.storageSubheading', {
                        defaultValue:
                            'Your offline library — artwork and any downloaded music — is saved here. Internal storage is the default; choose an SD card to save space. You can change this later in Settings.',
                    })}
                </p>
                <Stack gap="md" mt="xl">
                    <Select
                        allowDeselect={false}
                        data={options}
                        onChange={handleChange}
                        value={configuredId ?? INTERNAL}
                    />
                    <Button fullWidth onClick={onStart} size="md">
                        {t('page.syncGate.storageStart', { defaultValue: 'Start sync' })}
                    </Button>
                </Stack>

                {pending && (
                    <StorageMigrationModal
                        itemCount={stats.itemsDownloaded}
                        mode="switch"
                        onClose={() => setPending(null)}
                        opened={Boolean(pending)}
                        targetVolumeId={pending.id}
                        targetVolumeLabel={pending.label}
                        totalBytes={stats.bytesUsed}
                    />
                )}
            </div>
        </div>
    );
};
