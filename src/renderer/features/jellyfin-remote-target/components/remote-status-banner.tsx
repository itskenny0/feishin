import { Loader } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { usePeerSyncSettings } from '/@/renderer/store';

export const RemoteStatusBanner = () => {
    const { t } = useTranslation();
    const status = useRemoteStatus();
    const target = useRemoteTarget();
    const peerSync = usePeerSyncSettings();

    if (!peerSync.onboarded || !peerSync.jellyfinRemoteEnabled) return null;
    // Render for the two degraded/in-flight states that have real producers:
    // 'reconnecting' (sessions-poller missing-target ladder) and 'transferring'
    // (connect-lifecycle handoff). 'offline' is intentionally not handled — it
    // has no producer (see audit F4); the picker buttons no longer tint for it.
    if ((status !== 'reconnecting' && status !== 'transferring') || !target.deviceName) {
        return null;
    }

    const message =
        status === 'transferring'
            ? t('page.remoteTarget.transferring', {
                  defaultValue: 'Transferring playback to {{deviceName}}…',
                  deviceName: target.deviceName,
              })
            : t('page.remoteTarget.reconnecting', { deviceName: target.deviceName });

    return (
        <div
            style={{
                alignItems: 'center',
                background: 'var(--mantine-color-yellow-9)',
                color: 'var(--mantine-color-white)',
                display: 'flex',
                fontSize: '12px',
                gap: '8px',
                justifyContent: 'center',
                padding: '4px 12px',
            }}
        >
            <Loader color="white" size="xs" />
            <span>{message}</span>
        </div>
    );
};
