// StorageLocationSettings — Android-only control to choose where the offline
// cache (downloaded music + image variants) is stored: internal storage
// (IndexedDB, the default) or a removable SD card (filesystem backend). Picking
// a different location opens the move-or-start-fresh migration modal. Renders
// nothing on every non-Android platform.

import type { VolumeInfo } from '/@/renderer/cache/backends/volumes';

import { Select, Stack, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { refreshVolumes } from '/@/renderer/cache/backends/active-backend';
import { isAndroidNative } from '/@/renderer/cache/backends/volumes';
import { formatBytes } from '/@/renderer/cache/format';
import { StorageMigrationModal } from '/@/renderer/cache/storage-migration-modal';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store';

const INTERNAL = '__internal__';

export const StorageLocationSettings = () => {
    const { t } = useTranslation();
    const native = isAndroidNative();
    const stats = useCacheStore((s) => s.offlineMedia);
    // Re-render when the persisted volume id changes (migration finalize).
    const configuredId = useSettingsStore((s) => s.localCache?.android?.storageVolumeId ?? null);

    const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
    const [pending, setPending] = useState<null | { id: null | string; label: string }>(null);

    useEffect(() => {
        if (!native) return;
        void refreshVolumes().then(setVolumes);
    }, [native]);

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

    if (!native) return null;

    const options = [
        {
            label: t('page.setting.storageLocation.internal', {
                defaultValue: 'Internal storage',
            }),
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
        <Stack gap="xs">
            <Title order={6}>
                {t('page.setting.storageLocation.title', { defaultValue: 'Storage location' })}
            </Title>
            <Text c="dimmed" size="sm">
                {t('page.setting.storageLocation.description', {
                    defaultValue:
                        'Choose where downloaded music and images are stored. Move them to an SD card to save internal space.',
                })}
            </Text>
            <Select
                allowDeselect={false}
                data={options}
                onChange={handleChange}
                value={configuredId ?? INTERNAL}
            />

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
        </Stack>
    );
};
