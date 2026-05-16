import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { createAuthHeader } from '/@/renderer/api/jellyfin/jellyfin-api';
import { useCurrentServerWithCredential, useIsAdmin } from '/@/renderer/store/auth.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { toast } from '/@/shared/components/toast/toast';
import { ServerType } from '/@/shared/types/domain-types';
import { runWithConcurrency } from '/@/shared/utils/promise-pool';

const BULK_ACTION_CONCURRENCY = 4;

interface RefreshMetadataActionProps {
    disabled?: boolean;
    ids: string[];
}

/**
 * Asks the Jellyfin server to re-scan metadata for the selected item(s).
 * Useful for picking up file-edit changes without a full library scan.
 *
 * Endpoint: POST /Items/{id}/Refresh
 * https://api.jellyfin.org/#tag/ItemRefresh/operation/RefreshItem
 *
 * Hidden for non-Jellyfin servers; the equivalent on Subsonic/Navidrome is a
 * different request shape and isn't a focus for this fork.
 */
export const RefreshMetadataAction = ({ disabled, ids }: RefreshMetadataActionProps) => {
    const { t } = useTranslation();
    const server = useCurrentServerWithCredential();
    const { isAdmin } = useIsAdmin();

    const onSelect = useCallback(async () => {
        if (!server || server.type !== ServerType.JELLYFIN || ids.length === 0) return;
        const baseUrl = getServerUrl(server);
        if (!baseUrl || !server.credential) return;
        const serverUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const authHeader = `${createAuthHeader()}, Token="${server.credential}"`;

        const refreshOne = async (id: string): Promise<boolean> => {
            try {
                const res = await fetch(
                    // metadataRefreshMode defaults to FullRefresh; we ask for
                    // a Default refresh which is the closest server-side
                    // equivalent of "you probably edited this file, re-read it"
                    // without burning a full image/lyric refetch.
                    `${serverUrl}/Items/${encodeURIComponent(id)}/Refresh?metadataRefreshMode=Default&imageRefreshMode=Default&replaceAllImages=false&replaceAllMetadata=false`,
                    {
                        headers: {
                            Authorization: authHeader,
                            'Content-Type': 'application/json',
                        },
                        method: 'POST',
                    },
                );
                return res.ok;
            } catch (err) {
                console.warn('[refresh-metadata] request failed', err);
                return false;
            }
        };

        // Refresh is much heavier than mark-played server-side (it can hit
        // disk + image providers) — cap concurrency lower.
        const results = await runWithConcurrency(ids, BULK_ACTION_CONCURRENCY, (id) =>
            refreshOne(id),
        );
        const ok = results.filter(Boolean).length;
        if (ok === ids.length) {
            toast.info({
                message: t('page.contextMenu.refreshMetadata_success', { count: ok }),
            });
        } else if (ok > 0) {
            toast.warn({
                message: t('page.contextMenu.refreshMetadata_partial', {
                    failed: ids.length - ok,
                    success: ok,
                }),
            });
        } else {
            toast.error({ message: t('page.contextMenu.refreshMetadata_error') });
        }
    }, [ids, server, t]);

    // Jellyfin's /Items/{id}/Refresh requires Administrator scope. Hide the
    // option entirely for non-admin users rather than letting them click it
    // and watch a 403 error toast.
    if (!server || server.type !== ServerType.JELLYFIN || !isAdmin) return null;

    return (
        <ContextMenu.Item
            disabled={disabled || ids.length === 0}
            leftIcon="refresh"
            onSelect={onSelect}
        >
            {t('page.contextMenu.refreshMetadata')}
        </ContextMenu.Item>
    );
};
