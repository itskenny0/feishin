// StorageMigrationModal — the move-or-start-fresh dialog shared by the Android
// storage-location picker (mode 'switch') and the first-startup upgrade prompt
// (mode 'first-start'). Both choices share one engine (migrate.ts):
//   • Move      — copy every downloaded blob to the chosen volume, then drop
//                 the originals (resumable, with progress).
//   • Start fresh — discard the bytes and re-arm offline targets for re-download.
//
// On either completion the destination volume is activated, the blob-backend
// version is stamped (so the first-start prompt won't fire again), and volume
// health is reconciled.

import { Button, Group, Modal, Progress, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    getActiveBackend,
    markBlobBackendMigrated,
    reconcileVolumeHealth,
    setActiveVolume,
} from './backends/active-backend';
import { countMigratable, migrateBlobs, startFresh } from './backends/migrate';
import { formatBytes, formatCount } from './format';
import { refreshOfflineAvailability, refreshOfflineStats } from './offline-media';

export type StorageMigrationMode = 'first-start' | 'switch';

interface StorageMigrationModalProps {
    itemCount: number;
    mode: StorageMigrationMode;
    onClose: () => void;
    opened: boolean;
    targetVolumeId: null | string;
    targetVolumeLabel: string;
    totalBytes: number;
}

export const StorageMigrationModal = ({
    itemCount,
    mode,
    onClose,
    opened,
    targetVolumeId,
    targetVolumeLabel,
    totalBytes,
}: StorageMigrationModalProps) => {
    const { t } = useTranslation();
    const [busy, setBusy] = useState<'fresh' | 'move' | null>(null);
    const [progress, setProgress] = useState<null | { items: number; total: number }>(null);
    // True count of what will move — audio AND the image cache. The offline-media
    // stats only count audio, so passing those would read "0 items (0 B)" while
    // thousands of cached covers actually migrate. Computed across both tables.
    const [pending, setPending] = useState<null | { bytes: number; items: number }>(null);

    useEffect(() => {
        if (!opened) {
            setPending(null);
            return;
        }
        let cancelled = false;
        void countMigratable({
            toBackendId: targetVolumeId ? 'capacitor-fs' : 'idb',
            toVolumeId: targetVolumeId,
        }).then((result) => {
            if (!cancelled) setPending(result);
        });
        return () => {
            cancelled = true;
        };
    }, [opened, targetVolumeId]);

    const displayItems = pending?.items ?? itemCount;
    const displayBytes = pending?.bytes ?? totalBytes;

    const finalize = useCallback(async () => {
        markBlobBackendMigrated();
        await reconcileVolumeHealth();
        await refreshOfflineStats();
        await refreshOfflineAvailability();
        setBusy(null);
        setProgress(null);
        onClose();
    }, [onClose]);

    const handleMove = useCallback(async () => {
        setBusy('move');
        // Activate the destination FIRST so the backend writes land on the
        // chosen volume; sources are read via each row's own ref.
        await setActiveVolume(targetVolumeId);
        await migrateBlobs({
            onProgress: (p) => setProgress({ items: p.items, total: p.totalItems }),
            to: getActiveBackend(),
            toVolumeId: targetVolumeId,
        });
        await finalize();
    }, [finalize, targetVolumeId]);

    const handleStartFresh = useCallback(async () => {
        setBusy('fresh');
        await setActiveVolume(targetVolumeId);
        await startFresh();
        await finalize();
    }, [finalize, targetVolumeId]);

    const title =
        mode === 'first-start'
            ? t('page.setting.storageLocation.firstStartTitle', {
                  defaultValue: 'Move your downloads to the new storage system',
              })
            : t('page.setting.storageLocation.moveTitle', {
                  defaultValue: 'Move your downloads?',
              });

    const body =
        mode === 'first-start'
            ? t('page.setting.storageLocation.firstStartBody', {
                  defaultValue:
                      'Your offline downloads need to move to the new storage system. Migrate them now, or start fresh and re-download.',
              })
            : t('page.setting.storageLocation.moveBody', {
                  count: displayItems,
                  defaultValue:
                      'Move {{count}} items ({{size}}) to {{volume}}, or start fresh there?',
                  size: formatBytes(displayBytes),
                  volume: targetVolumeLabel,
              });

    return (
        <Modal centered onClose={busy ? () => {} : onClose} opened={opened} title={title}>
            <Stack gap="md">
                <Text size="sm">{body}</Text>

                {busy === 'move' && (
                    <Stack gap={4}>
                        <Progress
                            value={
                                progress && progress.total > 0
                                    ? (100 * progress.items) / progress.total
                                    : 0
                            }
                        />
                        <Text c="dimmed" size="xs">
                            {progress
                                ? `${formatCount(progress.items)} / ${formatCount(progress.total)}`
                                : t('page.setting.storageLocation.preparing', {
                                      defaultValue: 'Preparing…',
                                  })}
                        </Text>
                    </Stack>
                )}

                <Group justify="flex-end">
                    <Button disabled={Boolean(busy)} onClick={onClose} variant="default">
                        {t('common.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button
                        color="red"
                        disabled={Boolean(busy)}
                        loading={busy === 'fresh'}
                        onClick={() => void handleStartFresh()}
                        variant="light"
                    >
                        {t('page.setting.storageLocation.startFresh', {
                            defaultValue: 'Start fresh',
                        })}
                    </Button>
                    <Button
                        disabled={Boolean(busy)}
                        loading={busy === 'move'}
                        onClick={() => void handleMove()}
                    >
                        {mode === 'first-start'
                            ? t('page.setting.storageLocation.migrate', { defaultValue: 'Migrate' })
                            : t('page.setting.storageLocation.move', { defaultValue: 'Move' })}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};
