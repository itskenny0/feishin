import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuthStore, useSettingsStore } from '/@/renderer/store';

/**
 * First-launch opt-in modal for the local-first Jellyfin cache.
 *
 * Opens when:
 *  - the user has at least one configured server (`serverList` is non-empty)
 *  - `useSettingsStore.localCache.enabled` is still `undefined` (i.e. the
 *    user has never been asked)
 *
 * Either button below resolves the tri-state into `true` / `false`, which
 * closes the modal automatically because the open condition becomes false.
 * Dismissing via ESC or click-outside is treated as "Set up later" so we
 * don't keep nagging on every reload; the user can flip the master switch
 * on later from Settings -> Library sync.
 */
export const EnableCacheModal = () => {
    const { t } = useTranslation();
    const serverCount = useAuthStore((s) => Object.keys(s.serverList).length);
    const enabled = useSettingsStore((s) => s.localCache?.enabled);
    const setLocalCache = useSettingsStore((s) => s.actions.setLocalCache);

    const opened = serverCount > 0 && enabled === undefined;

    // One-shot log when the modal transitions to opened. Re-renders that
    // don't actually open it shouldn't spam the console.
    const wasOpenedRef = useRef(false);
    useEffect(() => {
        if (opened && !wasOpenedRef.current) {
            console.info('[cache] opt-in: modal shown');
            wasOpenedRef.current = true;
        } else if (!opened) {
            wasOpenedRef.current = false;
        }
    }, [opened]);

    const handleEnable = () => {
        console.info('[cache] opt-in: user enabled');
        setLocalCache({ enabled: true });
    };

    const handleDecline = () => {
        console.info('[cache] opt-in: user declined');
        setLocalCache({ enabled: false });
    };

    return (
        <Modal
            centered
            onClose={handleDecline}
            opened={opened}
            title={<Text fw={700}>{t('page.cacheOptIn.title')}</Text>}
            withCloseButton={false}
        >
            <Stack gap="md">
                <Text>{t('page.cacheOptIn.body1')}</Text>
                <Text c="dimmed" size="sm">
                    {t('page.cacheOptIn.body2')}
                </Text>
                <Group gap="sm" justify="flex-end">
                    <Button onClick={handleDecline} variant="default">
                        {t('page.cacheOptIn.declineButton')}
                    </Button>
                    <Button onClick={handleEnable}>{t('page.cacheOptIn.enableButton')}</Button>
                </Group>
            </Stack>
        </Modal>
    );
};
