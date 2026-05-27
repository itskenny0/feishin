import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DevicePickerList } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-list';
import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useCurrentServer } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Drawer } from '/@/shared/components/drawer/drawer';
import { ServerType } from '/@/shared/types/domain-types';

interface MobileDevicePickerButtonProps {
    iconSize?: 'lg' | 'md' | 'xl';
    variant?: 'default' | 'subtle' | 'transparent';
}

/**
 * Mobile Jellyfin Connect entry point — the cast icon (mini-player, fullscreen
 * bottom bar, home header). Opens the device list as a Spotify-style bottom
 * sheet. Renders nothing unless the current server is Jellyfin.
 */
export const MobileDevicePickerButton = ({
    iconSize = 'lg',
    variant = 'subtle',
}: MobileDevicePickerButtonProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const target = useRemoteTarget();
    const status = useRemoteStatus();
    const [opened, setOpened] = useState(false);

    if (!server || server.type !== ServerType.JELLYFIN) return null;

    const color =
        status === 'reconnecting' || status === 'offline'
            ? 'var(--mantine-color-yellow-5)'
            : target.isRemote
              ? 'var(--theme-colors-primary)'
              : undefined;

    return (
        <>
            <ActionIcon
                aria-label={t('page.remoteTarget.listenOn')}
                aria-pressed={target.isRemote}
                icon="remoteDevice"
                iconProps={{ size: iconSize, style: { color } }}
                onClick={(e) => {
                    // Stop the tap from bubbling to the mini-player container
                    // (which toggles fullscreen / owns swipe gestures).
                    e.stopPropagation();
                    setOpened(true);
                }}
                tooltip={{ label: t('page.remoteTarget.listenOn'), openDelay: 400 }}
                variant={variant}
            />
            <Drawer
                onClose={() => setOpened(false)}
                opened={opened}
                padding="md"
                position="bottom"
                radius="lg"
                size="auto"
                styles={{ content: { borderRadius: '16px 16px 0 0' } }}
                title={null}
                withCloseButton={false}
            >
                <DevicePickerList onClose={() => setOpened(false)} />
            </Drawer>
        </>
    );
};
