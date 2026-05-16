import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { createAuthHeader } from '/@/renderer/api/jellyfin/jellyfin-api';
import { useCurrentServerWithCredential } from '/@/renderer/store/auth.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { toast } from '/@/shared/components/toast/toast';
import { ServerType } from '/@/shared/types/domain-types';
import { runWithConcurrency } from '/@/shared/utils/promise-pool';

// Bound bulk-action HTTP request concurrency. Right-clicking thousands of
// songs and clicking "Mark played" otherwise sends every request in parallel
// which Jellyfin's rate-limiter rejects in batches.
const BULK_ACTION_CONCURRENCY = 8;

interface MarkPlayedActionProps {
    disabled?: boolean;
    ids: string[];
}

/**
 * Flip the played/unplayed state of one or more items on the Jellyfin server.
 * Useful for fixing wrong scrobble state or marking a chunk of items "played"
 * without actually playing them through.
 *
 *   Played:   POST   /Users/{userId}/PlayedItems/{itemId}
 *   Unplayed: DELETE /Users/{userId}/PlayedItems/{itemId}
 *
 * Jellyfin-only.
 */
const usePlayedToggleAction = (ids: string[], played: boolean) => {
    const server = useCurrentServerWithCredential();
    const queryClient = useQueryClient();
    return useCallback(async () => {
        if (!server || server.type !== ServerType.JELLYFIN || ids.length === 0) return;
        if (!server.credential || !server.userId) return;
        const baseUrl = getServerUrl(server);
        if (!baseUrl) return;
        const serverUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const authHeader = `${createAuthHeader()}, Token="${server.credential}"`;

        const flipOne = async (id: string): Promise<boolean> => {
            try {
                const userId = server.userId;
                if (!userId) return false;
                const res = await fetch(
                    `${serverUrl}/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(id)}`,
                    {
                        headers: { Authorization: authHeader },
                        method: played ? 'POST' : 'DELETE',
                    },
                );
                return res.ok;
            } catch (err) {
                console.warn('[mark-played] request failed', err);
                return false;
            }
        };

        const results = await runWithConcurrency(ids, BULK_ACTION_CONCURRENCY, (id) => flipOne(id));
        const ok = results.filter(Boolean).length;
        if (ok > 0) {
            // The visible userPlayCount/userPlayed flags live on song / album
            // / artist / playlist rows. Invalidate those namespaces only —
            // an earlier version used `predicate: () => true` which fired a
            // refetch storm across every cached query, but narrowing too
            // aggressively (the next pass omitted playlists) left
            // playlist-detail views showing stale play counts.
            const serverId = server.id;
            queryClient.invalidateQueries({
                predicate: (q) => {
                    const key = q.queryKey;
                    if (!Array.isArray(key) || key.length < 2) return false;
                    if (key[0] !== serverId) return false;
                    const ns = key[1];
                    return (
                        ns === 'songs' ||
                        ns === 'albums' ||
                        ns === 'albumArtists' ||
                        ns === 'playlists'
                    );
                },
            });
        }
        return ok;
    }, [ids, played, queryClient, server]);
};

export const MarkPlayedAction = ({ disabled, ids }: MarkPlayedActionProps) => {
    const { t } = useTranslation();
    const server = useCurrentServerWithCredential();
    const markPlayed = usePlayedToggleAction(ids, true);
    const markUnplayed = usePlayedToggleAction(ids, false);

    const handleMarkPlayed = useCallback(async () => {
        const ok = await markPlayed();
        if (typeof ok === 'number' && ok > 0) {
            toast.info({ message: t('page.contextMenu.markPlayed_done', { count: ok }) });
        } else if (ok === 0) {
            toast.error({ message: t('page.contextMenu.markPlayed_error') });
        }
    }, [markPlayed, t]);

    const handleMarkUnplayed = useCallback(async () => {
        const ok = await markUnplayed();
        if (typeof ok === 'number' && ok > 0) {
            toast.info({ message: t('page.contextMenu.markUnplayed_done', { count: ok }) });
        } else if (ok === 0) {
            toast.error({ message: t('page.contextMenu.markPlayed_error') });
        }
    }, [markUnplayed, t]);

    if (!server || server.type !== ServerType.JELLYFIN) return null;

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    disabled={disabled}
                    leftIcon="check"
                    onSelect={(e) => e.preventDefault()}
                    rightIcon="arrowRightS"
                >
                    {t('page.contextMenu.playedState')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item leftIcon="check" onSelect={handleMarkPlayed}>
                    {t('page.contextMenu.markPlayed')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="circle" onSelect={handleMarkUnplayed}>
                    {t('page.contextMenu.markUnplayed')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
