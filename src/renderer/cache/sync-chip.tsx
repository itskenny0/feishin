import { Group, Loader, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatCount } from './format';
import { useSmoothSweep } from './use-smooth-sweep';

import { useSettingsStore } from '/@/renderer/store';

export const SyncChip = () => {
    const { t } = useTranslation();
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const v = useSmoothSweep();

    if (!enabled) return null;
    if (!v.entity) return null;

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
