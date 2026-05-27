import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DevicePickerPopover } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-popover';
import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useCurrentServer } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { ServerType } from '/@/shared/types/domain-types';

interface MobileDevicePickerButtonProps {
    iconSize?: 'lg' | 'md' | 'xl';
    variant?: 'default' | 'subtle' | 'transparent';
}

/**
 * Compact Jellyfin Connect entry point for the mobile UI — the speaker/cast
 * icon Spotify places in the mini-player (left of play) and the fullscreen
 * player's bottom bar. Reuses the desktop DevicePickerPopover for the device
 * list; renders nothing unless the current server is Jellyfin.
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
        <DevicePickerPopover onClose={() => setOpened(false)} opened={opened} position="top">
            <div style={{ alignItems: 'center', display: 'flex' }}>
                <ActionIcon
                    aria-label={t('page.remoteTarget.listenOn')}
                    aria-pressed={target.isRemote}
                    icon="remoteDevice"
                    iconProps={{ size: iconSize, style: { color } }}
                    onClick={(e) => {
                        // Stop the tap from bubbling to the mini-player container
                        // (which toggles fullscreen / owns swipe gestures).
                        e.stopPropagation();
                        setOpened((v) => !v);
                    }}
                    tooltip={{ label: t('page.remoteTarget.listenOn'), openDelay: 400 }}
                    variant={variant}
                />
            </div>
        </DevicePickerPopover>
    );
};
