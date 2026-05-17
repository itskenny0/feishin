import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback } from 'react';

import { api } from '/@/renderer/api';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import {
    setTimestamp,
    useCurrentServerId,
    usePlayerStore,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';

export const useQueueRestoreTimestamp = () => {
    const player = usePlayerStore();

    usePlayerEvents(
        {
            onQueueRestored: (properties) => {
                const { position } = properties;

                setTimeout(() => {
                    setTimestamp(position);
                    player.mediaSeekToTimestamp(position);
                }, 100);
            },
        },
        [],
    );
};

export const QueueRestoreTimestampHook = () => {
    useQueueRestoreTimestamp();
    return null;
};

/**
 * Save the current play queue to the server.
 *
 * `silent: true` suppresses the success toast — used by the autosave hook,
 * which fires this every N song changes and would otherwise pop a toast at
 * the user every few minutes for an action they didn't initiate. Failure
 * toasts always fire so the user knows when something genuinely broke.
 */
export const useSaveQueue = () => {
    const serverId = useCurrentServerId();

    const mutation = useMutation({
        mutationFn: async (args?: { silent?: boolean }) => {
            const silent = args?.silent ?? false;
            if (!serverId) {
                throw new Error(t('error.serverRequired'));
            }

            const state = usePlayerStore.getState();
            const queue = state.getQueue();

            if (queue.items.some((item) => item._serverId !== serverId)) {
                toast.error({
                    message: t('error.multipleServerSaveQueueError'),
                    title: t('error.genericError'),
                });

                throw new Error(`${t('error.multipleServerSaveQueueError')}`);
            }

            try {
                await api.controller.savePlayQueue({
                    apiClientProps: { serverId },
                    query: {
                        currentIndex: queue.items.length > 0 ? state.player.index : undefined,
                        positionMs: useTimestampStoreBase.getState().timestamp * 1000,
                        songs: queue.items.map((item) => item.id),
                    },
                });

                if (!silent) {
                    toast.success({
                        message: t('form.saveQueue.success'),
                    });
                }
            } catch (error) {
                toast.error({
                    message: (error as Error).message,
                    title: t('error.saveQueueFailed'),
                });
                throw error;
            }
        },
    });

    return mutation;
};

export const useRestoreQueue = () => {
    const serverId = useCurrentServerId();
    const player = usePlayer();
    const queryClient = useQueryClient();

    const handleRestoreQueue = useCallback(async () => {
        if (!serverId) return;

        try {
            const queue = await queryClient.fetchQuery(
                songsQueries.getQueue({ query: {}, serverId }),
            );

            // No saved queue on the server — give explicit feedback so
            // the user doesn't click Restore and wonder if it ran.
            if (!queue || !queue.entry || queue.entry.length === 0) {
                toast.info({
                    message: t('form.restoreQueue.empty', {
                        defaultValue: 'No saved queue on the server',
                    }),
                });
                return;
            }

            player.setQueue(
                queue.entry,
                queue.currentIndex,
                queue.positionMs !== undefined ? queue.positionMs / 1000 : undefined,
            );

            toast.success({
                message: t('form.restoreQueue.success', {
                    count: queue.entry.length,
                    defaultValue_one: 'Restored 1 song from server',
                    defaultValue_other: 'Restored {{count}} songs from server',
                }),
            });
        } catch (error) {
            toast.error({
                message: (error as Error).message,
                title: t('error.genericError'),
            });
        }
    }, [player, queryClient, serverId]);

    return handleRestoreQueue;
};
