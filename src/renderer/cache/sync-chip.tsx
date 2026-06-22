import { Group, Loader, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatCount } from './format';
import { useCacheStore } from './store';
import { useSmoothSweep } from './use-smooth-sweep';

import { useSettingsStore } from '/@/renderer/store';

export const SyncChip = () => {
    const { t } = useTranslation();
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const syncActive = useCacheStore((s) => s.syncActive);
    const v = useSmoothSweep();

    if (!enabled) return null;

    // Between entity sweeps the per-entity `sweep` is momentarily undefined.
    // Keep a "Syncing…" indicator visible while the overall hydration is still
    // running so the chip doesn't flash empty (looking idle/stalled); only hide
    // it once the sync is actually finished.
    if (!v.entity) {
        if (!syncActive) return null;
        const preparing = t('page.home.syncChip.preparing', { defaultValue: 'Syncing…' });
        return (
            <Group aria-label={preparing} gap={6} wrap="nowrap">
                <Loader size="xs" type="dots" />
                <Text c="dimmed" size="xs">
                    {preparing}
                </Text>
            </Group>
        );
    }

    const label = t(`page.home.syncChip.${v.entity}`, { defaultValue: `Syncing ${v.entity}` });

    const itemsText = v.total
        ? `${formatCount(v.done)}/${formatCount(v.total)}`
        : formatCount(v.done);
    const bytesText = v.estimatedTotalBytes
        ? `${formatBytes(v.bytesDownloaded)} / ${formatBytes(v.estimatedTotalBytes)}`
        : formatBytes(v.bytesDownloaded);

    return (
        <Group aria-label={label} gap={6} wrap="nowrap">
            <Loader size="xs" type="dots" />
            <Text c="dimmed" size="xs">
                {label} · {itemsText} · {bytesText}
            </Text>
        </Group>
    );
};
