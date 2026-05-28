import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';

import { UnstyledButton } from '@mantine/core';
import isElectron from 'is-electron';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './device-picker.module.css';

import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { computeTransfer } from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { useRemoteDevices } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-devices';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerActions, usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { AppIcon, Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

/**
 * Pick a device-type icon from a session's client + device name, so the picker
 * reads like Spotify's "Connect to a device" list (phone / computer / web /
 * speaker glyphs) rather than a flat list of names.
 */
const deviceTypeIcon = (device: RemoteDevice): keyof typeof AppIcon => {
    const s = `${device.client} ${device.deviceName}`.toLowerCase();
    if (/android|iphone|ipad|phone|pixel|galaxy|findroid|mobile|tablet/.test(s)) {
        return 'devicePhone';
    }
    if (/web|chrome|firefox|safari|edge|opera|browser/.test(s)) return 'deviceWeb';
    if (/desktop|windows|\bmac\b|linux|jellyfin media player|kodi|computer|\bpc\b/.test(s)) {
        return 'deviceComputer';
    }
    return 'deviceSpeaker';
};

const Equalizer = () => (
    <span aria-hidden className={styles.equalizer}>
        <span />
        <span />
        <span />
    </span>
);

interface DevicePickerListProps {
    onClose: () => void;
    /**
     * Presentation variant. The desktop popover renders the built-in
     * header (title + refresh button); the mobile bottom sheet owns the
     * header itself (title + close button) and only wants the refresh
     * affordance, so it asks for `variant: 'mobile'`.
     */
    variant?: 'desktop' | 'mobile';
}

/**
 * The Jellyfin Connect device list — shared content rendered inside either the
 * desktop popover or the mobile bottom sheet. Owns selection, transfer and
 * refresh.
 */
export const DevicePickerList = ({ onClose, variant = 'desktop' }: DevicePickerListProps) => {
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

    // The poller keys off pickerOpen; keep it true while this list is mounted.
    useEffect(() => {
        setPickerOpen(true);
        return () => setPickerOpen(false);
    }, [setPickerOpen]);

    const selectLocal = () => {
        clearTarget();
        setSettings({ playback: { remoteTargetDeviceId: null, remoteTargetDeviceName: null } });
        onClose();
    };

    const selectDevice = (d: RemoteDevice) => {
        // Only hand off the local queue when the target is IDLE; if it's already
        // playing, adopt its state instead of overwriting it.
        const server = useAuthStore.getState().currentServer;
        if (
            !d.nowPlayingItemId &&
            server &&
            server.type === ServerType.JELLYFIN &&
            server.credential
        ) {
            const positionSec = useTimestampStoreBase.getState().timestamp;
            const transfer = computeTransfer(usePlayerStoreBase.getState(), positionSec);
            if (transfer) {
                void remoteTargetApi.play({
                    itemIds: transfer.itemIds,
                    playCommand: 'PlayNow',
                    server: server as ServerListItemWithCredential,
                    sessionId: d.sessionId,
                    startIndex: transfer.startIndex,
                    startPositionTicks: transfer.startPositionTicks,
                });
            }
        }

        playerActions.mediaPause();
        setTarget({
            capabilities: d.capabilities,
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            sessionId: d.sessionId,
        });
        setSettings({
            playback: { remoteTargetDeviceId: d.deviceId, remoteTargetDeviceName: d.deviceName },
        });
        toast.info({ message: t('page.remoteTarget.nowPlayingOn', { deviceName: d.deviceName }) });
        onClose();
    };

    const handleRefresh = () => {
        const server = useAuthStore.getState().currentServer;
        if (!server || server.type !== ServerType.JELLYFIN || !server.credential) return;
        sessionsPoller.start({
            onOffline: (deviceName) =>
                toast.info({ message: t('page.remoteTarget.wentOffline', { deviceName }) }),
            server,
        });
    };

    const thisDeviceIcon = isElectron() ? 'deviceComputer' : 'devicePhone';

    return (
        <div className={styles.list}>
            {variant === 'desktop' ? (
                <div className={styles.header}>
                    <Text className={styles.headerTitle}>
                        {t('page.remoteTarget.connectTitle', {
                            defaultValue: 'Connect to a device',
                        })}
                    </Text>
                    <ActionIcon
                        aria-label={t('common.refresh')}
                        icon="refresh"
                        iconProps={{ size: 'sm' }}
                        onClick={handleRefresh}
                        size="sm"
                        tooltip={{ label: t('common.refresh'), openDelay: 400 }}
                        variant="subtle"
                    />
                </div>
            ) : (
                <div className={styles.mobileToolbar}>
                    <ActionIcon
                        aria-label={t('common.refresh')}
                        icon="refresh"
                        iconProps={{ size: 'sm' }}
                        onClick={handleRefresh}
                        size="sm"
                        variant="subtle"
                    />
                </div>
            )}

            <UnstyledButton
                className={`${styles.row} ${target.isRemote ? '' : styles.rowActive}`}
                onClick={selectLocal}
            >
                <span className={styles.iconWrap}>
                    <Icon icon={thisDeviceIcon} size="lg" />
                </span>
                <span className={styles.rowText}>
                    <Text className={styles.rowTitle}>
                        {isElectron()
                            ? t('page.remoteTarget.thisComputer')
                            : t('page.remoteTarget.thisDevice', { defaultValue: 'This device' })}
                    </Text>
                    {!target.isRemote && (
                        <Text c="var(--theme-colors-primary)" className={styles.rowSubtitle}>
                            {t('page.remoteTarget.currentDevice', {
                                defaultValue: 'Current device',
                            })}
                        </Text>
                    )}
                </span>
                {!target.isRemote && <Icon fill="primary" icon="check" />}
            </UnstyledButton>

            {devices.length === 0 && pollError ? (
                <div className={styles.empty}>
                    <Text c="var(--mantine-color-red-5)" size="sm">
                        {t('page.remoteTarget.pollFailed', {
                            defaultValue: 'Could not reach the Jellyfin server',
                        })}
                    </Text>
                    <Text c="dimmed" size="xs">
                        {pollError}
                    </Text>
                </div>
            ) : devices.length === 0 ? (
                hasPolledOnce ? (
                    <div className={styles.empty}>
                        <Text c="dimmed" size="sm">
                            {t('page.remoteTarget.noDevices')}
                        </Text>
                        <Text c="dimmed" size="xs">
                            {t('page.remoteTarget.noDevicesHint')}
                        </Text>
                    </div>
                ) : (
                    <div className={styles.empty}>
                        <Text c="dimmed" size="sm">
                            {t('page.remoteTarget.searching', {
                                defaultValue: 'Searching for devices…',
                            })}
                        </Text>
                    </div>
                )
            ) : null}

            {devices.map((d) => {
                const active = target.deviceId === d.deviceId;
                const subtitle = d.nowPlayingTitle
                    ? `${d.nowPlayingTitle}${d.nowPlayingArtist ? ` — ${d.nowPlayingArtist}` : ''}`
                    : active
                      ? t('page.remoteTarget.currentDevice', { defaultValue: 'Current device' })
                      : d.isPaused
                        ? t('player.paused', { defaultValue: 'Paused' })
                        : t('common.idle', { defaultValue: 'Idle' });
                return (
                    <UnstyledButton
                        className={`${styles.row} ${active ? styles.rowActive : ''}`}
                        key={d.deviceId}
                        onClick={() => selectDevice(d)}
                    >
                        <span className={styles.iconWrap}>
                            <Icon
                                fill={active ? 'primary' : undefined}
                                icon={deviceTypeIcon(d)}
                                size="lg"
                            />
                        </span>
                        <span className={styles.rowText}>
                            <Text className={styles.rowTitle}>{d.deviceName}</Text>
                            <Text
                                c={active ? 'var(--theme-colors-primary)' : 'dimmed'}
                                className={styles.rowSubtitle}
                            >
                                {subtitle}
                            </Text>
                        </span>
                        {active &&
                            (d.nowPlayingItemId && !d.isPaused ? (
                                <Equalizer />
                            ) : (
                                <Icon fill="primary" icon="check" />
                            ))}
                    </UnstyledButton>
                );
            })}
        </div>
    );
};
