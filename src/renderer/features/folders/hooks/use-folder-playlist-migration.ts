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
    | {
          current: number;
          folderName: string;
          kind: 'per-folder';
          phase: 'adding' | 'collecting' | 'creating';
          total: number;
      }
    | { kind: 'creating' }
    | { kind: 'done' }
    | { kind: 'error'; message: string }
    | { kind: 'idle' };

export type StartMigrationInput = {
    branchRoots: Array<{ id: string; name: string }>;
    isPublic: boolean;
    mode: 'combined' | 'per-folder';
    namePrefix: string;
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
                if (input.mode === 'per-folder') {
                    let successCount = 0;
                    let totalSongs = 0;
                    const failures: string[] = [];

                    for (let i = 0; i < input.branchRoots.length; i += 1) {
                        const root = input.branchRoots[i];
                        try {
                            setStatus({
                                current: i + 1,
                                folderName: root.name,
                                kind: 'per-folder',
                                phase: 'collecting',
                                total: input.branchRoots.length,
                            });
                            // Non-null assertion safe: modal is Jellyfin-gated.
                            const songs = await api.controller.getFolderSongsRecursive!({
                                apiClientProps: { serverId },
                                query: { folderId: root.id },
                            });
                            if (songs.length === 0) continue;

                            setStatus({
                                current: i + 1,
                                folderName: root.name,
                                kind: 'per-folder',
                                phase: 'creating',
                                total: input.branchRoots.length,
                            });
                            const playlistName = `${input.namePrefix}${root.name}`;
                            const created = await api.controller.createPlaylist({
                                apiClientProps: { serverId },
                                body: { name: playlistName, public: input.isPublic },
                            });
                            if (!created?.id) {
                                throw new Error('createPlaylist returned no id');
                            }

                            setStatus({
                                current: i + 1,
                                folderName: root.name,
                                kind: 'per-folder',
                                phase: 'adding',
                                total: input.branchRoots.length,
                            });
                            await api.controller.addToPlaylist({
                                apiClientProps: { serverId },
                                body: { songId: songs.map((s) => s.id) },
                                query: { id: created.id },
                            });

                            successCount += 1;
                            totalSongs += songs.length;
                        } catch (err) {
                            console.warn('[folder-migration] per-folder failure', root.name, err);
                            failures.push(root.name);
                        }
                    }

                    // Invalidate playlist caches once at the end.
                    void queryClient.invalidateQueries({
                        exact: false,
                        queryKey: queryKeys.playlists.root(serverId),
                    });
                    void queryClient.invalidateQueries({
                        exact: false,
                        queryKey: infiniteLoaderDataQueryKey(serverId, LibraryItem.PLAYLIST),
                    });

                    if (successCount === 0) {
                        toast.error({
                            message: t('folderPlaylistMigration.allFailedToast'),
                        });
                        setStatus({
                            kind: 'error',
                            message: t('folderPlaylistMigration.allFailedToast'),
                        });
                        return;
                    }
                    if (failures.length > 0) {
                        toast.warn({
                            message: t('folderPlaylistMigration.perFolderPartialToast', {
                                songs: totalSongs,
                                success: successCount,
                                total: input.branchRoots.length,
                            }),
                        });
                    } else {
                        toast.success({
                            message: t('folderPlaylistMigration.perFolderSuccessToast', {
                                count: successCount,
                                songs: totalSongs,
                            }),
                        });
                    }
                    setStatus({ kind: 'done' });
                    input.onDone();
                    return;
                }

                // Combined mode (existing 1-to-N behaviour).
                // 1. Collect songs from each branch root sequentially.
                // The non-null assertion on getFolderSongsRecursive is safe here
                // because the modal entry point is Jellyfin-gated (Task 4).
                const allSongIds = new Set<string>();
                for (let i = 0; i < input.branchRoots.length; i += 1) {
                    const root = input.branchRoots[i];
                    setStatus({
                        collected: i,
                        kind: 'collecting',
                        total: input.branchRoots.length,
                    });
                    try {
                        const songs = await api.controller.getFolderSongsRecursive!({
                            apiClientProps: { serverId },
                            query: { folderId: root.id },
                        });
                        for (const s of songs) allSongIds.add(s.id);
                    } catch (err) {
                        console.warn('[folder-migration] failed to fetch folder', root.id, err);
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
