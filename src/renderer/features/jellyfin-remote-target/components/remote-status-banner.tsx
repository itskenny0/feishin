// src/renderer/features/jellyfin-remote-target/components/remote-status-banner.tsx
import { Loader } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { useRemoteStatus } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-status';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';

export const RemoteStatusBanner = () => {
    const { t } = useTranslation();
    const status = useRemoteStatus();
    const target = useRemoteTarget();

    if (status !== 'reconnecting' || !target.deviceName) return null;

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
            <Loader
                color="white"
                size="xs"
            />
            <span>
                {t('page.remoteTarget.reconnecting', { deviceName: target.deviceName })}
            </span>
        </div>
    );
};
