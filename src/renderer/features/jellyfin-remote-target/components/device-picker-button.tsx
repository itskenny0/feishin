import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DevicePickerPopover } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-popover';
import { TransportPill } from '/@/renderer/features/jellyfin-remote-target/components/transport-pill';
import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useCurrentServer, usePeerSyncSettings } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { ServerType } from '/@/shared/types/domain-types';

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export const DevicePickerButton = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const target = useRemoteTarget();
    const status = useRemoteStatus();
    const peerSync = usePeerSyncSettings();
    const [opened, setOpened] = useState(false);

    if (!server || server.type !== ServerType.JELLYFIN) return null;
    // Hide the Connect button entirely until the user has finished the
    // Sync & Connect setup wizard. The per-element visibility toggle in
    // settings can also hide it once onboarded.
    if (!peerSync.onboarded || !peerSync.jellyfinRemoteEnabled || !peerSync.ui.connectButton) {
        return null;
    }

    const color =
        status === 'reconnecting'
            ? 'var(--mantine-color-yellow-5)'
            : target.isRemote
              ? 'var(--theme-colors-primary)'
              : undefined;

    // Dynamic accessible name so the connected device is announced, not just
    // the static "Listen on" verb — reflects the visible device-name label.
    const ariaLabel =
        target.isRemote && target.deviceName
            ? t('page.remoteTarget.listenOnDevice', {
                  defaultValue: 'Listen on {{deviceName}}',
                  deviceName: target.deviceName,
              })
            : t('page.remoteTarget.listenOn');

    return (
        <DevicePickerPopover onClose={() => setOpened(false)} opened={opened}>
            <div style={{ alignItems: 'center', display: 'flex', gap: 4 }}>
                <ActionIcon
                    aria-label={ariaLabel}
                    aria-pressed={target.isRemote}
                    icon="remoteDevice"
                    iconProps={{ size: 'lg', style: { color } }}
                    onClick={() => setOpened((v) => !v)}
                    tooltip={{ label: ariaLabel }}
                    variant="default"
                />
                {target.isRemote && target.deviceName && (
                    <span style={{ color, fontSize: 12 }}>{truncate(target.deviceName, 16)}</span>
                )}
                <TransportPill />
            </div>
        </DevicePickerPopover>
    );
};
