// VolumeUnavailableBanner — app-wide warning shown while the configured Android
// storage volume (e.g. an SD card holding the offline cache) is absent or
// unmounted. Self-gates on the cache store's `volumeAvailable` flag (always
// true on the idb backend / non-Android platforms), so it renders nothing in
// the normal case and never needs an explicit mount/unmount from its parent.
//
// Mounted once in the default + mobile layouts so the warning floats above page
// content regardless of route. Metadata is never deleted while the volume is
// gone; reinserting the card flips the flag back and the banner disappears.

import { Group, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import styles from './offline-download-banner.module.css';
import { useVolumeAvailable } from './store';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useSettingsStore } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';

export const VolumeUnavailableBanner = () => {
    const { t } = useTranslation();
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const isMobileShell = useIsMobileShell();
    const available = useVolumeAvailable();

    if (!enabled || available) return null;

    const message = t('page.setting.storageLocation.volumeUnavailable', {
        defaultValue: 'SD card not available — reinsert it to access your downloads.',
    });

    return (
        <div
            aria-label={message}
            className={styles.banner}
            data-position={isMobileShell ? 'top' : 'bottom'}
            role="alert"
        >
            <Group align="center" gap="sm" wrap="nowrap">
                <Icon icon="cache" size="lg" />
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text c="dimmed" size="sm">
                        {message}
                    </Text>
                </Stack>
            </Group>
        </div>
    );
};
