import { useQuery } from '@tanstack/react-query';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '/@/renderer/api';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useCurrentServer } from '/@/renderer/store';
import { Text } from '/@/shared/components/text/text';
import { ServerType } from '/@/shared/types/domain-types';

const useServerInfo = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return null;
            try {
                return await api.controller.getServerInfo({
                    apiClientProps: { serverId, signal },
                });
            } catch (err) {
                console.warn('[server-info] failed', err);
                return null;
            }
        },
        // Server identity rarely changes mid-session; cache for the duration.
        queryKey: ['server-info', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 60,
    });

/**
 * Read-only widget that surfaces the connected server's identity. For Jellyfin
 * this includes the version, which is useful when filing bug reports or
 * checking whether features added in newer versions are available.
 */
export const ServerInfoWidget = memo(() => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const { data: info, isLoading } = useServerInfo(server?.id);

    if (!server) return null;

    const options: SettingOption[] = [
        {
            control: (
                <Text c="dimmed" size="sm">
                    {isLoading
                        ? '…'
                        : info?.version
                          ? t('setting.serverInfo_version_value', { version: info.version })
                          : '—'}
                </Text>
            ),
            description: server.url,
            isHidden: false,
            title:
                server.type === ServerType.JELLYFIN
                    ? t('setting.serverInfo_jellyfin')
                    : t('setting.serverInfo_other'),
        },
    ];

    return <SettingsSection options={options} />;
});
