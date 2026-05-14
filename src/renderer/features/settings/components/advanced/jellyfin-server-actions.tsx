import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createAuthHeader } from '/@/renderer/api/jellyfin/jellyfin-api';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useCurrentServerWithCredential } from '/@/renderer/store/auth.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { Button } from '/@/shared/components/button/button';
import { toast } from '/@/shared/components/toast/toast';
import { ServerType } from '/@/shared/types/domain-types';

/**
 * Jellyfin power-user actions. Surfaces server-side admin endpoints that are
 * useful when managing a library:
 *
 *   - Trigger a library scan: POST /Library/Refresh
 *
 * The server rejects with 403 when the user isn't an admin; we surface the
 * failure as a toast rather than gating the UI on a flag we don't always
 * have populated.
 */
export const JellyfinServerActions = memo(() => {
    const { t } = useTranslation();
    const server = useCurrentServerWithCredential();
    const [scanning, setScanning] = useState(false);

    const handleTriggerLibraryScan = useCallback(async () => {
        if (!server || server.type !== ServerType.JELLYFIN || !server.credential) return;
        const baseUrl = getServerUrl(server);
        if (!baseUrl) return;
        const serverUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const authHeader = `${createAuthHeader()}, Token="${server.credential}"`;

        setScanning(true);
        try {
            const res = await fetch(`${serverUrl}/Library/Refresh`, {
                headers: { Authorization: authHeader },
                method: 'POST',
            });
            if (res.ok) {
                toast.info({ message: t('setting.jellyfinAdmin_scanStarted') });
            } else if (res.status === 403) {
                toast.error({ message: t('setting.jellyfinAdmin_notAdmin') });
            } else {
                toast.error({
                    message: t('setting.jellyfinAdmin_scanFailed', { code: res.status }),
                });
            }
        } catch (err) {
            console.warn('[jellyfin-admin] scan request failed', err);
            toast.error({ message: t('setting.jellyfinAdmin_scanFailed', { code: 'network' }) });
        } finally {
            setScanning(false);
        }
    }, [server, t]);

    if (!server || server.type !== ServerType.JELLYFIN) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Button
                    disabled={scanning}
                    onClick={handleTriggerLibraryScan}
                    size="compact-sm"
                    variant="default"
                >
                    {scanning
                        ? t('setting.jellyfinAdmin_scanRunning')
                        : t('setting.jellyfinAdmin_scanLibrary')}
                </Button>
            ),
            description: t('setting.jellyfinAdmin_scanLibrary', { context: 'description' }),
            isHidden: false,
            title: t('setting.jellyfinAdmin_scanLibrary'),
        },
    ];

    return <SettingsSection options={options} />;
});
