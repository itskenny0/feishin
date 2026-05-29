import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet';
import { DevicePickerList } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-list';
import { TransportPill } from '/@/renderer/features/jellyfin-remote-target/components/transport-pill';
import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useCurrentServer, usePeerSyncSettings } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Portal } from '/@/shared/components/portal/portal';
import { ServerType } from '/@/shared/types/domain-types';

interface MobileDevicePickerButtonProps {
    iconSize?: 'lg' | 'md' | 'xl';
    variant?: 'default' | 'subtle' | 'transparent';
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

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
        status === 'reconnecting'
            ? 'var(--mantine-color-yellow-5)'
            : target.isRemote
              ? 'var(--theme-colors-primary)'
              : undefined;

    // Dynamic accessible name so a screen reader announces WHICH device is
    // targeted, not just the static "Listen on" verb — desktop parity.
    const ariaLabel =
        target.isRemote && target.deviceName
            ? t('page.remoteTarget.listenOnDevice', {
                  defaultValue: 'Listen on {{deviceName}}',
                  deviceName: target.deviceName,
              })
            : t('page.remoteTarget.listenOn');

    // Surface the device name visibly only on the roomier surfaces (the
    // fullscreen-controls 'xl' icon and the home-header 'lg' icon); the
    // cramped mini-playerbar ('md') stays icon-only.
    const showDeviceLabel = iconSize !== 'md' && target.isRemote && !!target.deviceName;

    return (
        <>
            <div style={{ alignItems: 'center', display: 'flex', gap: 4 }}>
                <ActionIcon
                    aria-label={ariaLabel}
                    aria-pressed={target.isRemote}
                    icon="remoteDevice"
                    iconProps={{ size: iconSize, style: { color } }}
                    onClick={(e) => {
                        // Stop the tap from bubbling to the mini-player container
                        // (which toggles fullscreen / owns swipe gestures).
                        e.stopPropagation();
                        setOpened(true);
                    }}
                    tooltip={{ label: ariaLabel, openDelay: 400 }}
                    variant={variant}
                />
                {showDeviceLabel && (
                    <span style={{ color, fontSize: 12 }}>
                        {truncate(target.deviceName as string, 12)}
                    </span>
                )}
                <TransportPill />
            </div>
            {/*
             * Portal the sheet to <body>. Mounted inline it lives inside the
             * route's <AnimatedPage>, whose `container-type: inline-size`
             * (animated-page.module.css) both makes it the containing block
             * for the sheet's `position: fixed` AND opens a new stacking
             * context. That context sits at the mobile-layout grid's
             * `main-content` track (z-index: auto), which paints BELOW the
             * sibling player bar (z-index: 200) and tab bar — so the sheet's
             * own z-index: 1000/1001 was trapped and the rows rendered under
             * the chrome. Portaling to <body> escapes that context so the
             * fixed positioning + z-index resolve against the document root
             * and the sheet sits above the player bar + tab bar. Desktop is
             * unaffected: its DevicePickerPopover already renders withinPortal.
             */}
            <Portal>
                <BottomSheet
                    onClose={handleClose}
                    opened={opened}
                    title={t('page.remoteTarget.connectTitle', {
                        defaultValue: 'Connect to a device',
                    })}
                >
                    <DevicePickerList onClose={handleClose} variant="mobile" />
                </BottomSheet>
            </Portal>
        </>
    );
};
