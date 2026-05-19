import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { infiniteLoaderDataQueryKey } from '/@/renderer/components/item-list/helpers/item-list-infinite-loader';
import { useCurrentServer } from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';

export type MigrationStatus =
    | { addedSongs: number; kind: 'adding'; totalSongs: number }
    | { collected: number; kind: 'collecting'; total: number }
    | { kind: 'creating' }
    | { kind: 'done' }
    | { kind: 'error'; message: string }
    | { kind: 'idle' };

export type StartMigrationInput = {
    branchRootIds: string[];
    isPublic: boolean;
    onDone: () => void;
    playlistName: string;
};

export const useFolderPlaylistMigration = () => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const currentServer = useCurrentServer();
    const [status, setStatus] = useState<MigrationStatus>({ kind: 'idle' });

    const start = useCallback(
        async (input: StartMigrationInput) => {
            const serverId = currentServer?.id;
            if (!serverId) {
                setStatus({ kind: 'error', message: 'No server selected' });
                return;
            }

            try {
                // 1. Collect songs from each branch root sequentially.
                // The non-null assertion on getFolderSongsRecursive is safe here
                // because the modal entry point is Jellyfin-gated (Task 4).
                const allSongIds = new Set<string>();
                for (let i = 0; i < input.branchRootIds.length; i += 1) {
                    const folderId = input.branchRootIds[i];
                    setStatus({
                        collected: i,
                        kind: 'collecting',
                        total: input.branchRootIds.length,
                    });
                    try {
                        const songs = await api.controller.getFolderSongsRecursive!({
                            apiClientProps: { serverId },
                            query: { folderId },
                        });
                        for (const s of songs) allSongIds.add(s.id);
                    } catch (err) {
                        console.warn('[folder-migration] failed to fetch folder', folderId, err);
                    }
                }

                if (allSongIds.size === 0) {
                    toast.warn({ message: t('folderPlaylistMigration.emptyToast') });
                    setStatus({ kind: 'idle' });
                    return;
                }

                // 2. Create the empty playlist.
                setStatus({ kind: 'creating' });
                const created = await api.controller.createPlaylist({
                    apiClientProps: { serverId },
                    body: { name: input.playlistName, public: input.isPublic },
                });
                if (!created?.id) {
                    throw new Error(t('folderPlaylistMigration.errorToast'));
                }

                // 3. Add the songs (chunked internally by the controller).
                const songIds = Array.from(allSongIds);
                setStatus({ addedSongs: 0, kind: 'adding', totalSongs: songIds.length });
                await api.controller.addToPlaylist({
                    apiClientProps: { serverId },
                    body: { songId: songIds },
                    query: { id: created.id },
                });
                setStatus({
                    addedSongs: songIds.length,
                    kind: 'adding',
                    totalSongs: songIds.length,
                });

                // 4. Invalidate the playlists query cache so the sidebar refreshes.
                // Mirrors useCreatePlaylist's invalidation set.
                void queryClient.invalidateQueries({
                    exact: false,
                    queryKey: queryKeys.playlists.root(serverId),
                });
                void queryClient.invalidateQueries({
                    exact: false,
                    queryKey: infiniteLoaderDataQueryKey(serverId, LibraryItem.PLAYLIST),
                });

                // 5. Toast + close.
                toast.success({
                    message: t('folderPlaylistMigration.successToast', {
                        count: songIds.length,
                        name: input.playlistName,
                    }),
                });
                setStatus({ kind: 'done' });
                input.onDone();
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : t('folderPlaylistMigration.errorToast');
                toast.error({ message });
                setStatus({ kind: 'error', message });
            }
        },
        [currentServer, queryClient, t],
    );

    return { start, status };
};
