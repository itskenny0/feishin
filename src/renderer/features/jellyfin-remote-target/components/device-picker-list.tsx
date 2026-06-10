import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';

import { UnstyledButton } from '@mantine/core';
import isElectron from 'is-electron';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './device-picker.module.css';

import { openTransportComparisonModal } from '/@/renderer/features/jellyfin-remote-target/components/transport-comparison';
import { startConnectLifecycle } from '/@/renderer/features/jellyfin-remote-target/controller/connect-lifecycle';
import { computeTransfer } from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { useRemoteDevices } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-devices';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { getActiveController } from '/@/renderer/features/peer-sync/controller/session-control-store';
import {
    pickTransportByJellyfinDeviceId,
    subscribe as subscribeTransport,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerActions, usePlayerStoreBase } from '/@/renderer/store/player.store';
import { usePeerSyncSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
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
    const peerSync = usePeerSyncSettings();
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

    /**
     * "Refreshing…" affordance state. When the user taps the refresh
     * action we flip this true, then clear it the moment the next poll
     * lands (devices reference changes) or after a hard cap. Without
     * this, the icon was a no-op visually — there was no signal that the
     * tap had done anything, especially on a 360x800 mobile viewport.
     */
    const [refreshing, setRefreshing] = useState(false);
    const refreshTimer = useRef<null | ReturnType<typeof setTimeout>>(null);
    useEffect(() => {
        if (!refreshing) return;
        // Flip false as soon as a fresh poll lands. The devices array is
        // a new reference per setDeviceList, so equality on the slice is
        // a faithful "we got something new" signal.
        setRefreshing(false);
        if (refreshTimer.current) {
            clearTimeout(refreshTimer.current);
            refreshTimer.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [devices]);
    useEffect(() => {
        return () => {
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
        };
    }, []);

    /**
     * Force-re-render on any transport flip so the lane badge (and the
     * hide-non-MQTT filter below) stays current as retained MQTT presence
     * frames arrive after the picker opens.
     */
    const [transportRev, setTransportRev] = useState(0);
    useEffect(() => {
        return subscribeTransport(() => setTransportRev((r) => r + 1));
    }, []);

    const selectLocal = () => {
        clearTarget();
        setSettings({ playback: { remoteTargetDeviceId: null, remoteTargetDeviceName: null } });
        onClose();
    };

    const selectDevice = (d: RemoteDevice) => {
        // A device that is currently BEING remote-controlled cannot also act
        // as a controller — the two roles are mutually exclusive (the session
        // would echo into itself). Block the pick and tell the user why.
        const activeController = getActiveController();
        if (activeController) {
            toast.warn({
                message: t('page.remoteTarget.beingControlled', {
                    defaultValue:
                        'This device is being remote-controlled right now — it cannot control another player.',
                }),
            });
            return;
        }

        const server = useAuthStore.getState().currentServer;
        const isJellyfin = !!server && server.type === ServerType.JELLYFIN && !!server.credential;

        // Only hand off the local queue when the target is IDLE; if it's already
        // playing, adopt its state instead of overwriting it.
        let transfer: ReturnType<typeof computeTransfer> = null;
        if (!d.nowPlayingItemId && isJellyfin) {
            const positionSec = useTimestampStoreBase.getState().timestamp;
            transfer = computeTransfer(usePlayerStoreBase.getState(), positionSec);
        }

        playerActions.mediaPause();
        setTarget({
            capabilities: d.capabilities,
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            // E1/J3: bind the target to the server that established it so
            // commands can't leak to a different server after a switch. Store
            // the canonical "no owner" as `undefined` (the reducer maps it to
            // null) rather than '' — a normalization tidy, not a behavior
            // change: the getRemoteCtx guard
            // (`target.ownerServerId && target.ownerServerId !== id`) treats
            // '', null, and undefined identically (all falsy → guard skipped).
            // When no Jellyfin server is current the owner is genuinely unknown
            // and the cross-server guard stays disabled either way.
            ownerServerId: server?.id ?? undefined,
            sessionId: d.sessionId,
        });
        setSettings({
            playback: { remoteTargetDeviceId: d.deviceId, remoteTargetDeviceName: d.deviceName },
        });

        startConnectLifecycle({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            onRevert: () => {
                clearTarget();
                setSettings({
                    playback: { remoteTargetDeviceId: null, remoteTargetDeviceName: null },
                });
            },
            sessionId: d.sessionId,
            t,
            transfer:
                transfer && isJellyfin
                    ? {
                          itemIds: transfer.itemIds,
                          server: server as ServerListItemWithCredential,
                          startIndex: transfer.startIndex,
                          startPositionTicks: transfer.startPositionTicks,
                      }
                    : null,
        });
        onClose();
    };

    const handleRefresh = () => {
        const server = useAuthStore.getState().currentServer;
        if (!server || server.type !== ServerType.JELLYFIN || !server.credential) return;
        setRefreshing(true);
        // Hard cap so the spinner can't sit forever if the poll fires and
        // returns the same deviceList reference.
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => setRefreshing(false), 2500);
        // refresh() forces an immediate tick on the running poller without
        // going through stop()/start() — that path resets hasPolledOnce,
        // clears optimistic holds, and drops the WS-driven fallbackMode
        // flag, none of which we want here.
        sessionsPoller.refresh();
    };

    const thisDeviceIcon = isElectron() ? 'deviceComputer' : 'devicePhone';

    /**
     * Derive the per-device view (lane + icon) ONCE per render and filter it
     * down to what's actually shown. Without this, an unrelated peer's
     * transport flip (which bumps `transportRev` and force-re-renders the
     * whole list) would re-run `pickTransportByJellyfinDeviceId` twice and the
     * `deviceTypeIcon` regex once for every device, inline, on every flip.
     * Keyed on `transportRev` so the lane badge / hide-non-MQTT filter still
     * react to flips — drop that dep and the badge goes stale after a flip.
     */
    const visibleRows = useMemo(
        () =>
            devices
                .map((d) => ({
                    device: d,
                    icon: deviceTypeIcon(d),
                    lane: pickTransportByJellyfinDeviceId(d.deviceId),
                }))
                // "Hide devices without MQTT" — filter that removes
                // Jellyfin-only rows (jellyfin-web, jellyfin-android-tv,
                // other Feishins that haven't published presence yet) from
                // the picker. Default ON, but only MEANINGFUL when the MQTT
                // transport is configured — with peer-sync off there is no
                // MQTT lane at all and the filter would hide every device.
                // The currently-selected target always stays visible so the
                // user doesn't lose it mid-toggle.
                .filter(({ device, lane }) => {
                    if (!peerSync.enabled || !peerSync.ui.hideNonMqttDevices) return true;
                    if (target.deviceId === device.deviceId) return true;
                    return lane === 'mqtt';
                }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [devices, peerSync.enabled, peerSync.ui.hideNonMqttDevices, target.deviceId, transportRev],
    );

    // The unfiltered list was non-empty but the MQTT filter zeroed it — drive
    // a distinct empty-state so the picker doesn't silently look broken after
    // the user toggles "Hide devices without MQTT".
    const filteredToZero =
        devices.length > 0 &&
        visibleRows.length === 0 &&
        peerSync.enabled &&
        peerSync.ui.hideNonMqttDevices;

    return (
        <div
            aria-label={t('page.remoteTarget.connectTitle', {
                defaultValue: 'Connect to a device',
            })}
            className={styles.list}
            role="listbox"
        >
            {variant === 'desktop' ? (
                <div className={styles.header}>
                    <Text className={styles.headerTitle}>
                        {t('page.remoteTarget.connectTitle', {
                            defaultValue: 'Connect to a device',
                        })}
                    </Text>
                    <ActionIcon
                        aria-label={t('page.remoteTarget.compare.title', {
                            defaultValue: 'MQTT vs Jellyfin remote',
                        })}
                        icon="info"
                        iconProps={{ size: 'sm' }}
                        onClick={() =>
                            openTransportComparisonModal(
                                t('page.remoteTarget.compare.title', {
                                    defaultValue: 'MQTT vs Jellyfin remote',
                                }),
                            )
                        }
                        size="sm"
                        tooltip={{
                            label: t('page.remoteTarget.compare.title', {
                                defaultValue: 'MQTT vs Jellyfin remote',
                            }),
                            openDelay: 400,
                        }}
                        variant="subtle"
                    />
                    <ActionIcon
                        aria-busy={refreshing}
                        aria-label={t('common.refresh')}
                        disabled={refreshing}
                        icon={refreshing ? 'spinner' : 'refresh'}
                        iconProps={{ animate: refreshing ? 'spin' : undefined, size: 'sm' }}
                        onClick={handleRefresh}
                        size="sm"
                        tooltip={{ label: t('common.refresh'), openDelay: 400 }}
                        variant="subtle"
                    />
                </div>
            ) : (
                <div className={styles.mobileToolbar}>
                    {refreshing && (
                        <Text className={styles.refreshLabel} size="xs">
                            {t('page.remoteTarget.refreshing', {
                                defaultValue: 'Refreshing…',
                            })}
                        </Text>
                    )}
                    <ActionIcon
                        aria-label={t('page.remoteTarget.compare.title', {
                            defaultValue: 'MQTT vs Jellyfin remote',
                        })}
                        icon="info"
                        iconProps={{ size: 'sm' }}
                        onClick={() =>
                            openTransportComparisonModal(
                                t('page.remoteTarget.compare.title', {
                                    defaultValue: 'MQTT vs Jellyfin remote',
                                }),
                            )
                        }
                        size="sm"
                        variant="subtle"
                    />
                    <ActionIcon
                        aria-busy={refreshing}
                        aria-label={t('common.refresh')}
                        disabled={refreshing}
                        icon={refreshing ? 'spinner' : 'refresh'}
                        iconProps={{ animate: refreshing ? 'spin' : undefined, size: 'sm' }}
                        onClick={handleRefresh}
                        size="sm"
                        variant="subtle"
                    />
                </div>
            )}

            <UnstyledButton
                aria-selected={!target.isRemote}
                className={`${styles.row} ${target.isRemote ? '' : styles.rowActive}`}
                onClick={selectLocal}
                role="option"
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
            ) : filteredToZero ? (
                // Unfiltered list non-empty but the MQTT filter removed every
                // row — explain WHY the list went blank after the toggle so the
                // picker doesn't read as broken.
                <div className={styles.empty}>
                    <Text c="dimmed" size="sm">
                        {t('page.remoteTarget.noMqttPeers', {
                            defaultValue: 'No MQTT peers found',
                        })}
                    </Text>
                    <Text c="dimmed" size="xs">
                        {t('page.remoteTarget.noMqttPeersHint', {
                            defaultValue:
                                "Turn off 'Hide devices without MQTT' to see all Jellyfin clients.",
                        })}
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
                        <span className={styles.searchingRow}>
                            <Icon animate="spin" icon="spinner" size="sm" />
                            <Text c="dimmed" size="sm">
                                {t('page.remoteTarget.searching', {
                                    defaultValue: 'Searching for devices…',
                                })}
                            </Text>
                        </span>
                    </div>
                )
            ) : null}

            {visibleRows.map(({ device: d, icon, lane }) => {
                const active = target.deviceId === d.deviceId;
                const subtitle = d.nowPlayingTitle
                    ? `${d.nowPlayingTitle}${d.nowPlayingArtist ? ` — ${d.nowPlayingArtist}` : ''}`
                    : active
                      ? t('page.remoteTarget.currentDevice', { defaultValue: 'Current device' })
                      : d.isPaused
                        ? t('player.paused', { defaultValue: 'Paused' })
                        : t('common.idle', { defaultValue: 'Idle' });
                // Lane = whichever transport would be used to drive this device
                // right now (resolved once in `visibleRows`). Bridges via the
                // Jellyfin deviceId so a Feishin peer that's published its `dev`
                // in MQTT presence lights up the MQTT badge; jellyfin-web and
                // other clients that don't publish stay on Jellyfin. Keep the
                // badge on the active row too so the lane stays legible — the
                // selected affordance is carried by aria-selected + the
                // equalizer/check, not by hiding the badge (audit F8).
                const showLaneBadge =
                    peerSync.onboarded &&
                    peerSync.jellyfinRemoteEnabled &&
                    peerSync.ui.pickerBadges &&
                    lane === 'mqtt';
                return (
                    <UnstyledButton
                        aria-selected={active}
                        className={`${styles.row} ${active ? styles.rowActive : ''}`}
                        key={d.deviceId}
                        onClick={() => selectDevice(d)}
                        role="option"
                    >
                        <span className={styles.iconWrap}>
                            <Icon fill={active ? 'primary' : undefined} icon={icon} size="lg" />
                        </span>
                        <span className={styles.rowText}>
                            <span className={styles.titleLine}>
                                <Text className={styles.rowTitle}>{d.deviceName}</Text>
                                {showLaneBadge && (
                                    <span
                                        aria-label={t('page.remoteTarget.laneBadgeAriaLabel', {
                                            defaultValue: 'MQTT lane active',
                                        })}
                                        className={styles.laneBadge}
                                    >
                                        {t('common.transportMqtt', { defaultValue: 'MQTT' })}
                                    </span>
                                )}
                            </span>
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
