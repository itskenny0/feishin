import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet';
import { DevicePickerList } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-list';
import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useCurrentServer, usePeerSyncSettings } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { ServerType } from '/@/shared/types/domain-types';

interface MobileDevicePickerButtonProps {
    iconSize?: 'lg' | 'md' | 'xl';
    variant?: 'default' | 'subtle' | 'transparent';
}

/**
 * Mobile Jellyfin Connect entry point — the cast icon (mini-player, fullscreen
 * bottom bar, home header). Opens the device list as a Spotify-style bottom
 * sheet rendered by the shared `BottomSheet` component. Renders nothing unless
 * the current server is Jellyfin.
 */
export const MobileDevicePickerButton = ({
    iconSize = 'lg',
    variant = 'subtle',
}: MobileDevicePickerButtonProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const target = useRemoteTarget();
    const status = useRemoteStatus();
    const peerSync = usePeerSyncSettings();
    const [opened, setOpened] = useState(false);

    const handleClose = useCallback(() => setOpened(false), []);

    if (!server || server.type !== ServerType.JELLYFIN) return null;
    if (!peerSync.onboarded || !peerSync.jellyfinRemoteEnabled || !peerSync.ui.connectButton) {
        return null;
    }

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
            <BottomSheet
                onClose={handleClose}
                opened={opened}
                title={t('page.remoteTarget.connectTitle', { defaultValue: 'Connect to a device' })}
            >
                <DevicePickerList onClose={handleClose} variant="mobile" />
            </BottomSheet>
        </>
    );
};
