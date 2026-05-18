import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';

import { UnstyledButton } from '@mantine/core';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteDevices } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-devices';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { usePlayerActions } from '/@/renderer/store/player.store';
import { useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Icon } from '/@/shared/components/icon/icon';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

interface DevicePickerPopoverProps {
    children: React.ReactNode;
    onClose: () => void;
    opened: boolean;
}

export const DevicePickerPopover = ({ children, onClose, opened }: DevicePickerPopoverProps) => {
    const { t } = useTranslation();
    const devices = useRemoteDevices();
    const target = useRemoteTarget();
    const hasPolledOnce = useRemoteTargetStore((s) => s.hasPolledOnce);
    const pollError = useRemoteTargetStore((s) => s.pollError);
    const setPickerOpen = useRemoteTargetStore((s) => s.actions.setPickerOpen);
    const setTarget = useRemoteTargetStore((s) => s.actions.setTarget);
    const clearTarget = useRemoteTargetStore((s) => s.actions.clearTarget);
    const { setSettings } = useSettingsStoreActions();
    const playerActions = usePlayerActions();

    useEffect(() => {
        setPickerOpen(opened);
    }, [opened, setPickerOpen]);

    const selectLocal = () => {
        clearTarget();
        setSettings({
            playback: {
                remoteTargetDeviceId: null,
                remoteTargetDeviceName: null,
            },
        });
        onClose();
    };

    const selectDevice = (d: RemoteDevice) => {
        // Stop local audio first so we don't double up.
        playerActions.mediaPause();

        setTarget({
            capabilities: d.capabilities,
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            sessionId: d.sessionId,
        });
        setSettings({
            playback: {
                remoteTargetDeviceId: d.deviceId,
                remoteTargetDeviceName: d.deviceName,
            },
        });
        toast.info({ message: t('page.remoteTarget.nowPlayingOn', { deviceName: d.deviceName }) });
        onClose();
    };

    return (
        <Popover onClose={onClose} opened={opened} position="top-end" shadow="md" width={280}>
            <Popover.Target>{children}</Popover.Target>
            <Popover.Dropdown p="xs">
                <Stack gap={4}>
                    <Text c="dimmed" fw={600} size="xs" tt="uppercase">
                        {t('page.remoteTarget.listenOn')}
                    </Text>
                    <UnstyledButton
                        onClick={selectLocal}
                        style={{
                            alignItems: 'center',
                            color: target.isRemote ? undefined : 'var(--theme-colors-primary)',
                            display: 'flex',
                            gap: 8,
                            padding: '6px 8px',
                        }}
                    >
                        {!target.isRemote && <Icon icon="check" />}
                        <Text fw={600} size="sm">
                            {t('page.remoteTarget.thisComputer')}
                        </Text>
                    </UnstyledButton>
                    {devices.length === 0 && pollError ? (
                        <Stack gap={2} px="xs" py={6}>
                            <Text c="var(--mantine-color-red-5)" size="sm">
                                {t('page.remoteTarget.pollFailed', {
                                    defaultValue: 'Could not reach the Jellyfin server',
                                })}
                            </Text>
                            <Text c="dimmed" size="xs">
                                {pollError}
                            </Text>
                        </Stack>
                    ) : devices.length === 0 ? (
                        hasPolledOnce ? (
                            <Stack gap={2} px="xs" py={6}>
                                <Text c="dimmed" size="sm">
                                    {t('page.remoteTarget.noDevices')}
                                </Text>
                                <Text c="dimmed" size="xs">
                                    {t('page.remoteTarget.noDevicesHint')}
                                </Text>
                            </Stack>
                        ) : (
                            <Text c="dimmed" px="xs" py={6} size="sm">
                                {t('page.remoteTarget.searching', {
                                    defaultValue: 'Searching for devices…',
                                })}
                            </Text>
                        )
                    ) : null}
                    {devices.map((d) => {
                        const active = target.deviceId === d.deviceId;
                        const subtitle = d.nowPlayingTitle
                            ? `${d.nowPlayingTitle}${d.nowPlayingArtist ? ` — ${d.nowPlayingArtist}` : ''}`
                            : d.isPaused
                              ? 'paused'
                              : 'idle';
                        return (
                            <UnstyledButton
                                key={d.deviceId}
                                onClick={() => selectDevice(d)}
                                style={{
                                    alignItems: 'center',
                                    color: active ? 'var(--theme-colors-primary)' : undefined,
                                    display: 'flex',
                                    gap: 8,
                                    padding: '6px 8px',
                                }}
                            >
                                {active && <Icon icon="check" />}
                                <Stack gap={0}>
                                    <Text fw={600} size="sm">
                                        {d.deviceName}
                                    </Text>
                                    <Text c="dimmed" lineClamp={1} size="xs">
                                        {subtitle}
                                    </Text>
                                </Stack>
                            </UnstyledButton>
                        );
                    })}
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
