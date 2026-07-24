import { closeAllModals, openModal } from '@mantine/modals';
import { QueryClient, useIsFetching, useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid/non-secure';
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { streamAdaptivePaged } from '/@/renderer/api/paged-fetch';
import { queryKeys } from '/@/renderer/api/query-keys';
import { resolveSongsByItemTypeLocal } from '/@/renderer/cache';
import { useCacheStore } from '/@/renderer/cache/store';
import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { artistsQueries } from '/@/renderer/features/artists/api/artists-api';
import {
    computeRemotePlay,
    nextJellyfinRepeat,
    playerRepeatToJellyfin,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { peerDispatcher } from '/@/renderer/features/peer-sync/controller/peer-dispatcher';
import {
    getPeerIdForJellyfinDeviceId,
    pickTransport,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { jellyfinToPeerRepeat } from '/@/renderer/features/peer-sync/protocol/builders';
import {
    fetchPlaylistSongsBatch,
    filterSongsByPlayerFilters,
    getAlbumArtistSongsById,
    getAlbumSongsById,
    getGenreSongsById,
    getPlaylistSongsById,
    getSongsByFolder,
    getSongsByIds,
} from '/@/renderer/features/player/utils';
import { selectOfflinePlayable } from '/@/renderer/features/player/utils/offline-play-guard';
import { playlistsQueries } from '/@/renderer/features/playlists/api/playlists-api';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { getNavigatorOnline } from '/@/renderer/lib/network-status';
import { AddToQueueType, usePlayerActions, useSettingsStore } from '/@/renderer/store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { logger } from '/@/renderer/utils/logger';
import { shuffle as shuffleArray } from '/@/renderer/utils/shuffle';
import { sortSongsByFetchedOrder } from '/@/shared/api/utils';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { useLocalStorage } from '/@/shared/hooks/use-local-storage';
import {
    AlbumListSort,
    instanceOfCancellationError,
    LibraryItem,
    PlaylistSongListResponse,
    QueueSong,
    Song,
} from '/@/shared/types/domain-types';
import { Play, PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

export interface PlayerContext {
    addToQueueByData: (
        data: Song[],
        type: AddToQueueType,
        playSongId?: string,
        contextPlaylistId?: null | string,
    ) => void;
    addToQueueByFetch: (
        serverId: string,
        id: string[],
        itemType: LibraryItem,
        type: AddToQueueType,
    ) => void;
    addToQueueByListQuery: (
        serverId: string,
        query: any,
        itemType: LibraryItem,
        type: AddToQueueType,
    ) => Promise<void>;
    clearQueue: () => void;
    clearSelected: (items: QueueSong[]) => void;
    decreaseVolume: (amount: number) => void;
    getQueue: () => QueueSong[];
    increaseVolume: (amount: number) => void;
    mediaNext: (toNextAlbum: boolean) => void;
    mediaPause: () => void;
    mediaPlay: (id?: string) => void;
    mediaPlayByIndex: (index: number) => void;
    mediaPrevious: (toPreviousAlbum: boolean) => void;
    mediaSeekToTimestamp: (timestamp: number) => void;
    mediaSkipBackward: () => void;
    mediaSkipForward: () => void;
    mediaStop: (options?: { reset?: boolean }) => void;
    mediaToggleMute: () => void;
    mediaTogglePlayPause: () => void;
    moveSelectedTo: (items: QueueSong[], edge: 'bottom' | 'top', uniqueId: string) => void;
    moveSelectedToBottom: (items: QueueSong[]) => void;
    moveSelectedToNext: (items: QueueSong[]) => void;
    moveSelectedToTop: (items: QueueSong[]) => void;
    setQueue: (data: Song[], index?: number, position?: number) => void;
    setRepeat: (repeat: PlayerRepeat) => void;
    setShuffle: (shuffle: PlayerShuffle) => void;
    setSpeed: (speed: number) => void;
    setVolume: (volume: number) => void;
    shuffle: () => void;
    shuffleAll: () => void;
    shuffleSelected: (items: QueueSong[]) => void;
    toggleRepeat: () => void;
    toggleShuffle: () => void;
}

export const PlayerContext = createContext<PlayerContext>({
    addToQueueByData: () => {},
    addToQueueByFetch: () => {},
    addToQueueByListQuery: async () => {},
    clearQueue: () => {},
    clearSelected: () => {},
    decreaseVolume: () => {},
    getQueue: () => [],
    increaseVolume: () => {},
    mediaNext: () => {},
    mediaPause: () => {},
    mediaPlay: () => {},
    mediaPlayByIndex: () => {},
    mediaPrevious: () => {},
    mediaSeekToTimestamp: () => {},
    mediaSkipBackward: () => {},
    mediaSkipForward: () => {},
    mediaStop: () => {},
    mediaToggleMute: () => {},
    mediaTogglePlayPause: () => {},
    moveSelectedTo: () => {},
    moveSelectedToBottom: () => {},
    moveSelectedToNext: () => {},
    moveSelectedToTop: () => {},
    setQueue: () => {},
    setRepeat: () => {},
    setShuffle: () => {},
    setSpeed: () => {},
    setVolume: () => {},
    shuffle: () => {},
    shuffleAll: () => {},
    shuffleSelected: () => {},
    toggleRepeat: () => {},
    toggleShuffle: () => {},
});

const getRootQueryKey = (itemType: LibraryItem, serverId: string) => {
    switch (itemType) {
        case LibraryItem.ALBUM:
            return queryKeys.songs.root(serverId);
        case LibraryItem.ALBUM_ARTIST:
            return queryKeys.songs.root(serverId);
        case LibraryItem.ARTIST:
            return queryKeys.songs.root(serverId);
        case LibraryItem.GENRE:
            return queryKeys.songs.root(serverId);
        case LibraryItem.PLAYLIST:
            return queryKeys.playlists.root(serverId);
        case LibraryItem.SONG:
            return queryKeys.songs.root(serverId);
        default:
            return queryKeys.songs.root(serverId);
    }
};

const isReplaceQueueType = (type: AddToQueueType): boolean => {
    if (typeof type === 'object') return false;
    return type === Play.NOW || type === Play.SHUFFLE;
};

// HashRouter puts the route in location.hash, not pathname.
const inferPlaylistContextFromUrl = (): null | string => {
    const route = window.location.hash.replace(/^#/, '');
    const match = route.match(/^\/playlists\/([^/]+)/);
    return match ? match[1] : null;
};

// Stamps each song with the playlist it was queued from, so the sidebar highlight
// can be derived from whichever song is currently playing (see useCurrentPlaylistContextId).
const tagPlaylistContext = (songs: Song[], contextPlaylistId: string): Song[] =>
    songs.map((song) => ({ ...song, _contextPlaylistId: contextPlaylistId }));

export const PlayerProvider = ({ children }: { children: React.ReactNode }) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const storeActions = usePlayerActions();

    /**
     * Build a dispatcher context only when we're in remote mode. Used by every
     * branched method below. Reads at call time so we don't subscribe and
     * re-render the provider on every Sessions tick.
     *
     * `peer.peerId` is resolved through the transport-selector bridge from the
     * picked Jellyfin Sessions deviceId. When the bridge has no mapping (the
     * target hasn't published MQTT presence, e.g. jellyfin-web) the empty
     * peerId makes `peerDispatcher.route` fall back to the Jellyfin lane
     * unconditionally — same behaviour as before the bridge existed.
     */
    const getRemoteCtx = useCallback(() => {
        const target = useRemoteTargetStore.getState();
        if (!target.targetDeviceId || !target.sessionId || target.sessionId === '__pending__') {
            return null;
        }
        const server = useAuthStore.getState().currentServer;
        if (!server?.credential) return null;
        // E1: refuse to act when the live server no longer owns this target. A
        // server switch leaves the old target's deviceId/sessionId in the store
        // for up to ~60s (the offline ladder); without this guard a pause/seek/
        // volume tap would POST to the NEW server using the OLD session id.
        // Compare by id (not object identity) so a token/musicFolder refresh
        // that keeps the same server id doesn't drop a healthy session.
        if (target.ownerServerId && target.ownerServerId !== server.id) return null;
        return {
            peer: {
                peerId: getPeerIdForJellyfinDeviceId(target.targetDeviceId) ?? '',
                userId: server.userId ?? '',
            },
            server,
            sessionId: target.sessionId,
        };
    }, []);

    /**
     * J4: capability gate for the Jellyfin lane. Many Jellyfin targets advertise
     * transport control but NOT SetVolume / SetRepeatMode / SetShuffleQueue /
     * Mute (jellyfin-web, Chromecast). Sending those yields a 4xx → error toast,
     * or a silent no-op while the controller's optimistic mirror lies (slider
     * moves then snaps back). Before optimistically patching + dispatching a
     * GeneralCommand-class verb, confirm the target's `SupportedCommands`
     * (mirrored.capabilities) actually lists it. The MQTT lane has no such
     * restriction — its receiver applies every verb locally — so the check is
     * SKIPPED when MQTT owns the lane. Returns true when the command may proceed.
     */
    const remoteCmdAllowed = useCallback(
        (remote: { peer: { peerId: string } }, capability: string): boolean => {
            // MQTT lane: receiver handles everything, no capability gating.
            if (remote.peer.peerId && pickTransport(remote.peer.peerId) === 'mqtt') return true;
            const caps = useRemoteTargetStore.getState().mirrored.capabilities;
            // Be permissive when the target advertised NO capabilities at all —
            // an empty list usually means the session simply didn't report them,
            // and refusing every command there would be worse than today.
            if (!caps || caps.length === 0) return true;
            return caps.includes(capability);
        },
        [],
    );

    /**
     * If a remote target is active and this intent can be expressed as a
     * Jellyfin push, send it and return true. Used by every play path so
     * album/playlist/song plays all land on the remote device, not locally.
     */
    const tryRemotePlay = useCallback(
        (songs: { id: string }[], type: AddToQueueType, playSongId?: string): boolean => {
            const remote = getRemoteCtx();
            if (!remote) return false;
            const push = computeRemotePlay(songs, type, playSongId);
            if (!push) return false;
            peerDispatcher.play(remote, {
                itemIds: push.itemIds,
                playCommand: push.playCommand,
                startIndex: push.startIndex,
            });
            return true;
        },
        [getRemoteCtx],
    );

    const timeoutIds = useRef<null | Record<string, ReturnType<typeof setTimeout>>>({});

    // Aborts the in-flight background tail fetch started by the streaming
    // "Play Now" path in addToQueueByFetch (below) when a newer play call
    // supersedes it, so a superseded fetch can't keep appending stale songs
    // to the queue after the user has moved on.
    const streamTailAbortRef = useRef<AbortController | null>(null);

    const [doNotShowAgain, setDoNotShowAgain] = useLocalStorage({
        defaultValue: false,
        key: 'large_fetch_confirmation',
    });

    const confirmLargeFetch = useCallback((): Promise<boolean> => {
        if (doNotShowAgain) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            openModal({
                children: (
                    <ConfirmModal
                        labels={{
                            cancel: t('common.cancel'),
                            confirm: t('common.confirm'),
                        }}
                        onCancel={() => {
                            resolve(false);
                            closeAllModals();
                        }}
                        onConfirm={() => {
                            resolve(true);
                            closeAllModals();
                        }}
                    >
                        <Stack>
                            <Text>{t('form.largeFetchConfirmation.description')}</Text>
                            <Checkbox
                                label={t('common.doNotShowAgain')}
                                onChange={(event) => {
                                    setDoNotShowAgain(event.currentTarget.checked);
                                }}
                            />
                        </Stack>
                    </ConfirmModal>
                ),
                title: t('form.largeFetchConfirmation.title'),
            });
        });
    }, [doNotShowAgain, setDoNotShowAgain, t]);

    const addToQueueByData = useCallback(
        (
            data: Song[],
            type: AddToQueueType,
            playSongId?: string,
            contextPlaylistId?: null | string,
        ) => {
            if (tryRemotePlay(data, type, playSongId)) return;

            // Offline guard: while offline only downloaded songs can actually
            // play (use-stream-url serves a local blob; a non-downloaded song
            // resolves to a dead URL). Block the request with a clear toast
            // when the targeted/only songs aren't downloaded, and narrow
            // multi-song adds to the downloaded subset. No-op while online.
            const songKeys = useCacheStore.getState().offlineAvailability.songKeys;
            const guard = selectOfflinePlayable({
                isAvailable: (serverId, songId) => songKeys.has(`${serverId}:${songId}`),
                // HARD offline only (OS link down). The combined signal also
                // flips on a stalled IMAGE fetch (markServerUnreachable), and
                // an art-host hiccup must never block audio playback — when
                // the link is up we let the play attempt run and surface its
                // own error path instead.
                online: getNavigatorOnline(),
                playSongId,
                songs: data,
            });
            if (!guard.allowed) {
                console.warn('[offline-ux] play blocked — song(s) not available offline');
                toast.warn({ message: t('error.offlineNotAvailable') });
                return;
            }
            const playableData = guard.playable;

            const filters = useSettingsStore.getState().playback.filters;
            let filteredData = filterSongsByPlayerFilters(playableData, filters);
            const resolvedContextId =
                contextPlaylistId ??
                (isReplaceQueueType(type) ? inferPlaylistContextFromUrl() : null);
            if (resolvedContextId) {
                filteredData = tagPlaylistContext(filteredData, resolvedContextId);
            }

            if (typeof type === 'object' && 'edge' in type && type.edge !== null) {
                const edge = type.edge === 'top' ? 'top' : 'bottom';

                logger.debug('Added to queue by data', {
                    data: playableData.length,
                    edge,
                    filtered: filteredData.length,
                    type,
                    uniqueId: type.uniqueId,
                });

                storeActions.addToQueueByUniqueId(filteredData, type.uniqueId, edge, playSongId);
            } else {
                logger.debug('Added to queue by type', {
                    data: playableData.length,
                    filtered: filteredData.length,
                    type,
                });

                storeActions.addToQueueByType(filteredData, type as Play, playSongId);
            }
        },
        [storeActions, tryRemotePlay, t],
    );

    const addToQueueByFetch = useCallback(
        async (serverId: string, id: string[], itemType: LibraryItem, type: AddToQueueType) => {
            let toastId: null | string = null;
            const fetchId = nanoid();

            // A new play call supersedes any previous streaming-tail fetch
            // that may still be appending songs to the queue in the background.
            streamTailAbortRef.current?.abort();
            streamTailAbortRef.current = null;

            timeoutIds.current = {
                ...timeoutIds.current,
                [fetchId]: setTimeout(() => {
                    toastId =
                        toast.info({
                            autoClose: false,
                            message: t('player.playbackFetchCancel'),
                            onClose: () => {
                                queryClient.cancelQueries({
                                    exact: false,
                                    queryKey: getRootQueryKey(itemType, serverId),
                                });

                                queryClient.cancelQueries({
                                    exact: false,
                                    queryKey: queryKeys.player.fetch(),
                                });
                            },
                            title: t('player.playbackFetchInProgress'),
                        }) ?? null;
                }, 2000),
            };

            try {
                logger.debug('Added to queue by fetch', { ids: id, itemType, serverId, type });

                // Streaming start for a single playlist with Play.NOW: fetch
                // a small first batch so playback can begin immediately, then
                // append the remainder in the background. Avoids the 5-60s
                // wait users see on large playlists where the full fetch has
                // to complete before song 1 starts.
                if (itemType === LibraryItem.PLAYLIST && type === Play.NOW && id.length === 1) {
                    const STREAM_FIRST_BATCH = 50;
                    const playlistId = id[0];

                    const firstBatch = await fetchPlaylistSongsBatch({
                        limit: STREAM_FIRST_BATCH,
                        playlistId,
                        queryClient,
                        serverId,
                        startIndex: 0,
                    });

                    clearTimeout(timeoutIds.current[fetchId] as ReturnType<typeof setTimeout>);
                    delete timeoutIds.current[fetchId];
                    if (toastId) {
                        toast.hide(toastId);
                    }

                    const filters = useSettingsStore.getState().playback.filters;
                    const filteredFirst = filterSongsByPlayerFilters(firstBatch.items, filters);

                    // Remote target active: push the batch to the device and stop;
                    // Jellyfin owns the queue from here, so skip the local tail append.
                    if (tryRemotePlay(filteredFirst, type)) return;

                    // Start playback immediately with batch 1.
                    storeActions.addToQueueByType(filteredFirst, Play.NOW);

                    // If the playlist is larger than the first batch, fetch the
                    // rest in the background and append it page by page as it
                    // arrives. We don't await so the caller's "play" click is
                    // acknowledged the moment song 1 starts. streamAdaptivePaged
                    // shrinks the page size on a slow/overloaded server instead
                    // of hanging on one oversized request — or, worse, silently
                    // dropping every track past it.
                    const total = firstBatch.totalRecordCount ?? 0;
                    const tailStart = firstBatch.items.length;
                    if (total > tailStart) {
                        const tailAbortController = new AbortController();
                        streamTailAbortRef.current = tailAbortController;

                        void (async () => {
                            try {
                                const tailPages = streamAdaptivePaged<Song>(
                                    async (pageStartIndex, limit) => {
                                        const page = await fetchPlaylistSongsBatch({
                                            limit,
                                            playlistId,
                                            queryClient,
                                            serverId,
                                            startIndex: tailStart + pageStartIndex,
                                        });
                                        return page.items;
                                    },
                                    {
                                        label: 'playlist-play-now-tail',
                                        signal: tailAbortController.signal,
                                    },
                                );

                                for await (const page of tailPages) {
                                    if (tailAbortController.signal.aborted) break;
                                    const filteredTail = filterSongsByPlayerFilters(page, filters);
                                    if (filteredTail.length > 0) {
                                        storeActions.addToQueueByType(filteredTail, Play.LAST);
                                    }
                                }
                            } catch (err) {
                                if (instanceOfCancellationError(err)) return;
                                logger.error('Add to queue by fetch failed', {
                                    error: (err as Error).message,
                                    phase: 'streaming-tail',
                                });
                            }
                        })();
                    }
                    return;
                }

                const songs = await queryClient.fetchQuery({
                    gcTime: 0,
                    queryFn: () => {
                        return fetchSongsByItemType(queryClient, serverId, {
                            id,
                            itemType,
                        });
                    },
                    queryKey: queryKeys.player.fetch(),
                    staleTime: 0,
                });

                clearTimeout(timeoutIds.current[fetchId] as ReturnType<typeof setTimeout>);
                delete timeoutIds.current[fetchId];
                if (toastId) {
                    toast.hide(toastId);
                }

                let sortedSongs: Song[] = [];

                // Playlists should use the native order of the playlist
                if (itemType === LibraryItem.PLAYLIST) {
                    sortedSongs = songs;
                } else {
                    sortedSongs = sortSongsByFetchedOrder(songs, id, itemType);
                }

                const filters = useSettingsStore.getState().playback.filters;
                let filteredSongs = filterSongsByPlayerFilters(sortedSongs, filters);

                // Songs from multiple playlists are merged together, so there is no single
                // playlist to attribute them to: skip tagging (and URL inference) entirely.
                const isMultiPlaylist = itemType === LibraryItem.PLAYLIST && id.length > 1;
                const explicitId =
                    itemType === LibraryItem.PLAYLIST && id.length === 1 ? id[0] : null;
                const resolvedContextId =
                    explicitId ??
                    (!isMultiPlaylist && isReplaceQueueType(type)
                        ? inferPlaylistContextFromUrl()
                        : null);
                if (resolvedContextId) {
                    filteredSongs = tagPlaylistContext(filteredSongs, resolvedContextId);
                }

                if (tryRemotePlay(filteredSongs, type)) return;

                if (typeof type === 'object' && 'edge' in type && type.edge !== null) {
                    const edge = type.edge === 'top' ? 'top' : 'bottom';
                    storeActions.addToQueueByUniqueId(filteredSongs, type.uniqueId, edge);
                } else {
                    storeActions.addToQueueByType(filteredSongs, type as Play);
                }
            } catch (err: any) {
                if (instanceOfCancellationError(err)) {
                    return;
                }

                clearTimeout(timeoutIds.current[fetchId] as ReturnType<typeof setTimeout>);
                delete timeoutIds.current[fetchId];
                if (toastId) {
                    toast.hide(toastId);
                }

                toast.error({
                    message: err.message,
                    title: t('error.genericError') as string,
                });
            }
        },
        [queryClient, storeActions, t, tryRemotePlay],
    );

    const addToQueueByListQuery = useCallback(
        async (serverId: string, query: any, itemType: LibraryItem, type: AddToQueueType) => {
            let toastId: null | string = null;
            let fetchId: null | string = null;

            logger.debug('Added to queue by list query', { itemType, query, serverId, type });

            try {
                let totalCount = 0;
                let listQueryFn: any;
                let listCountQueryFn: any;

                // Special handling for albums with random sort: fetch in name order, then shuffle client-side
                const isAlbumRandomSort =
                    itemType === LibraryItem.ALBUM && query.sortBy === AlbumListSort.RANDOM;

                const fetchQuery = isAlbumRandomSort
                    ? { ...query, sortBy: AlbumListSort.NAME }
                    : query;

                switch (itemType) {
                    case LibraryItem.ALBUM: {
                        listQueryFn = albumQueries.list;
                        listCountQueryFn = albumQueries.listCount;
                        break;
                    }
                    case LibraryItem.ALBUM_ARTIST: {
                        listQueryFn = artistsQueries.albumArtistList;
                        listCountQueryFn = artistsQueries.albumArtistListCount;
                        break;
                    }
                    case LibraryItem.ARTIST: {
                        listQueryFn = artistsQueries.artistList;
                        listCountQueryFn = artistsQueries.artistListCount;
                        break;
                    }
                    case LibraryItem.PLAYLIST: {
                        listQueryFn = playlistsQueries.list;
                        listCountQueryFn = playlistsQueries.listCount;
                        break;
                    }
                    case LibraryItem.SONG: {
                        listQueryFn = songsQueries.list;
                        listCountQueryFn = songsQueries.listCount;
                        break;
                    }
                    default: {
                        throw new Error(`Unsupported item type: ${itemType}`);
                    }
                }

                // Get total count
                const countResult = (await queryClient.fetchQuery({
                    ...listCountQueryFn({
                        query: { ...fetchQuery },
                        serverId,
                    }),
                    gcTime: 0,
                    queryKey: queryKeys.player.fetch(),
                    staleTime: 0,
                })) as number;
                totalCount = countResult || 0;

                const allResults: Song[] | string[] = [];
                const pageSize = 500;

                const confirmed = await confirmLargeFetch();
                if (!confirmed) {
                    return;
                }

                // Start timeout only after confirmation (if needed)
                fetchId = nanoid();

                timeoutIds.current = {
                    ...timeoutIds.current,
                    [fetchId]: setTimeout(() => {
                        toastId =
                            toast.info({
                                autoClose: false,
                                message: t('player.playbackFetchCancel'),
                                onClose: () => {
                                    logger.debug('Cancelled fetch', { itemType, serverId });

                                    queryClient.cancelQueries({
                                        exact: false,
                                        queryKey: getRootQueryKey(itemType, serverId),
                                    });

                                    queryClient.cancelQueries({
                                        exact: false,
                                        queryKey: queryKeys.player.fetch(),
                                    });
                                },
                                title: t('player.playbackFetchInProgress'),
                            }) ?? null;
                    }, 2000),
                };
                let startIndex = 0;

                while (startIndex < totalCount) {
                    const pageQuery = {
                        ...fetchQuery,
                        limit: pageSize,
                        startIndex,
                    };

                    const pageResult = (await queryClient.fetchQuery({
                        ...listQueryFn({
                            query: pageQuery,
                            serverId,
                        }),
                        gcTime: 0,
                        queryKey: queryKeys.player.fetch({ startIndex }),
                        staleTime: 0,
                    })) as { items: any[] };

                    if (pageResult?.items) {
                        if (itemType === LibraryItem.SONG) {
                            allResults.push(...pageResult.items);
                        } else {
                            const pageIds = pageResult.items.map((item: any) => item.id);
                            allResults.push(...pageIds);
                        }
                    }

                    // If we got fewer items than requested, we've reached the end
                    if (!pageResult?.items || pageResult.items.length < pageSize) {
                        break;
                    }

                    startIndex += pageSize;
                }

                if (fetchId && timeoutIds.current) {
                    clearTimeout(timeoutIds.current[fetchId] as ReturnType<typeof setTimeout>);
                    delete timeoutIds.current[fetchId];
                }

                if (toastId) {
                    toast.hide(toastId);
                }

                // Shuffle album IDs client-side if this was a random sort request
                let finalResults = allResults;
                if (isAlbumRandomSort && itemType === LibraryItem.ALBUM) {
                    finalResults = shuffleArray(allResults as string[]) as typeof allResults;
                }

                if (itemType === LibraryItem.SONG) {
                    addToQueueByData(finalResults as Song[], type);
                } else {
                    await addToQueueByFetch(serverId, finalResults as string[], itemType, type);
                }
            } catch (err: any) {
                if (instanceOfCancellationError(err)) {
                    return;
                }

                if (fetchId && timeoutIds.current) {
                    clearTimeout(timeoutIds.current[fetchId] as ReturnType<typeof setTimeout>);
                    delete timeoutIds.current[fetchId];
                }
                if (toastId) {
                    toast.hide(toastId);
                }

                toast.error({
                    message: err.message,
                    title: t('error.genericError') as string,
                });
            }
        },
        [queryClient, confirmLargeFetch, t, addToQueueByData, addToQueueByFetch],
    );

    const clearQueue = useCallback(() => {
        logger.debug('Cleared queue');

        storeActions.clearQueue();
    }, [storeActions]);

    const clearSelected = useCallback(
        (items: QueueSong[]) => {
            logger.debug('Cleared selected', { items: items.length });

            storeActions.clearSelected(items);
        },
        [storeActions],
    );

    const decreaseVolume = useCallback(
        (amount: number) => {
            logger.debug('Decreased volume', { amount });

            storeActions.decreaseVolume(amount);
        },
        [storeActions],
    );

    const getQueue = useCallback(() => {
        logger.debug('Cleared queue');

        const queue = storeActions.getQueue();
        return queue.items;
    }, [storeActions]);

    const increaseVolume = useCallback(
        (amount: number) => {
            logger.debug('Increased volume', { amount });

            storeActions.increaseVolume(amount);
        },
        [storeActions],
    );

    const mediaNext = useCallback(
        (toNextAlbum: boolean) => {
            logger.debug('Media next');
            const remote = getRemoteCtx();
            if (remote) {
                peerDispatcher.next(remote);
                useRemoteTargetStore.getState().actions.optimisticNext();
                return;
            }
            storeActions.mediaNext(toNextAlbum);
        },
        [getRemoteCtx, storeActions],
    );

    const mediaPause = useCallback(() => {
        logger.debug('Media pause');

        const remote = getRemoteCtx();
        if (remote) {
            peerDispatcher.pause(remote);
            useRemoteTargetStore.getState().actions.setPaused(true);
            return;
        }
        storeActions.mediaPause();
    }, [getRemoteCtx, storeActions]);

    // Queue-jump offline guard. A queue can be built online and then played
    // offline; jumping to a non-downloaded queue item would hand the audio
    // element a dead URL. When offline, refuse the jump for a song that has no
    // local blob and surface the same toast. Returns true when the jump was
    // blocked. No-op while online or when the song is downloaded.
    const blockOfflineJump = useCallback(
        (song: undefined | { _serverId: string; id: string }): boolean => {
            if (!song || getNavigatorOnline()) return false;
            const songKeys = useCacheStore.getState().offlineAvailability.songKeys;
            if (songKeys.has(`${song._serverId}:${song.id}`)) return false;
            console.warn('[offline-ux] queue jump blocked — song not available offline');
            toast.warn({ message: t('error.offlineNotAvailable') });
            return true;
        },
        [t],
    );

    const mediaPlayByIndex = useCallback(
        (index: number) => {
            logger.debug('Media play by index', { index });

            const remote = getRemoteCtx();
            if (remote) {
                peerDispatcher.skipToIndex(remote, index);
                // Optimistically move the mirror so the now-playing card / queue
                // highlight don't lag the click. D6: the position/pause/index
                // patch must NOT depend on a hydrated queue — on the MQTT lane
                // mirrored.queue is often empty, which previously left an MQTT
                // skip with no feedback while a Jellyfin skip updated instantly.
                const s = useRemoteTargetStore.getState();
                const actions = s.actions;
                const queue = s.mirrored.queue;
                const now = Date.now();
                const item = index >= 0 && index < queue.length ? queue[index] : undefined;
                actions.applyMirrorFromServer({
                    // Only swap the track when the queue actually holds it.
                    ...(item ? { nowPlayingItem: item } : {}),
                    queueIndex: index,
                });
                // Finding 1: install a queueIndex hold alongside the track hold
                // so a stale poll's recomputed (old) index can't snap the queue
                // highlight back while the new track is held.
                actions.hold('queueIndex', index);
                actions.patchPlayState({ isPaused: false, positionMs: 0, positionSampledAt: now });
                if (item) {
                    // Track-identity hold (DEFAULT_HOLD_MS ~6s, covering the next
                    // PlaybackProgress frame) so a stale frame can't snap the
                    // highlight back to the previous index.
                    actions.hold('nowPlayingItemId', item.id);
                }
                return;
            }
            const target = usePlayerStoreBase.getState().getQueueOrder().items[index];
            if (blockOfflineJump(target)) return;
            storeActions.mediaPlayByIndex(index);
        },
        [blockOfflineJump, getRemoteCtx, storeActions],
    );

    const mediaPlay = useCallback(
        (id?: string) => {
            logger.debug('Media play', { id });

            const remote = getRemoteCtx();
            if (remote) {
                // H2: locally `mediaPlay(uniqueId)` JUMPS to that queue item (a
                // double-click on a queue row, item-list-controls passes
                // queueSong._uniqueId). The remote branch used to discard `id`
                // and merely resume the current track — wrong song. Resolve the
                // id against the mirrored queue (match by _uniqueId OR id, since
                // MQTT-lane stubs only carry id) and route through the corrected
                // skip-to-index path. Only fall back to resume when no id was
                // supplied.
                if (id) {
                    const queue = useRemoteTargetStore.getState().mirrored.queue;
                    const idx = queue.findIndex(
                        (s) => (s as { _uniqueId?: string })._uniqueId === id || s.id === id,
                    );
                    if (idx >= 0) {
                        mediaPlayByIndex(idx);
                        return;
                    }
                    // Unknown id (un-hydrated mirror) — best effort: resume.
                }
                peerDispatcher.unpause(remote);
                useRemoteTargetStore.getState().actions.setPaused(false);
                return;
            }
            // A bare `mediaPlay()` (resume current) is never blocked; only an
            // explicit jump to a specific queued song is guarded offline.
            if (id) {
                const items = usePlayerStoreBase.getState().getQueueOrder().items;
                const target = items.find(
                    (s) => (s as { _uniqueId?: string })._uniqueId === id || s.id === id,
                );
                if (blockOfflineJump(target)) return;
            }
            storeActions.mediaPlay(id);
        },
        [blockOfflineJump, getRemoteCtx, mediaPlayByIndex, storeActions],
    );

    const mediaPrevious = useCallback(
        (toPreviousAlbum: boolean) => {
            logger.debug('Media previous');
            const remote = getRemoteCtx();
            if (remote) {
                peerDispatcher.previous(remote);
                useRemoteTargetStore.getState().actions.optimisticPrevious();
                return;
            }
            storeActions.mediaPrevious(toPreviousAlbum);
        },
        [getRemoteCtx, storeActions],
    );

    const mediaStop = useCallback(
        (options?: { reset?: boolean }) => {
            logger.debug('Media stop', { reset: options?.reset });
            const remote = getRemoteCtx();
            if (remote) {
                peerDispatcher.stop(remote);
                return;
            }
            storeActions.mediaStop(options);
        },
        [getRemoteCtx, storeActions],
    );

    const mediaSeekToTimestamp = useCallback(
        (timestamp: number) => {
            logger.debug('Media seek to timestamp', { timestamp });
            const remote = getRemoteCtx();
            if (remote) {
                const positionMs = Math.max(0, Math.round(timestamp * 1000));
                peerDispatcher.seek(remote, positionMs);
                useRemoteTargetStore.getState().actions.optimisticSeek(positionMs);
                return;
            }
            storeActions.mediaSeekToTimestamp(timestamp);
        },
        [getRemoteCtx, storeActions],
    );

    const mediaSkipBackward = useCallback(() => {
        logger.debug('Media skip backward');

        storeActions.mediaSkipBackward();
    }, [storeActions]);

    const mediaSkipForward = useCallback(() => {
        logger.debug('Media skip forward');

        storeActions.mediaSkipForward();
    }, [storeActions]);

    const setQueue = useCallback(
        (data: Song[], index?: number, position?: number) => {
            logger.debug('Set queue', {
                data: data.length,
                index,
                position,
            });

            storeActions.setQueue(data, index, position);
        },
        [storeActions],
    );

    const setSpeed = useCallback(
        (speed: number) => {
            logger.debug('Set speed', { speed });

            storeActions.setSpeed(speed);
        },
        [storeActions],
    );

    const mediaToggleMute = useCallback(() => {
        logger.debug('Media toggle mute');
        const remote = getRemoteCtx();
        if (remote) {
            // J4: skip when the Jellyfin target can't mute — avoids a 4xx toast
            // and a lying optimistic icon flip on a capable-but-limited target.
            if (!remoteCmdAllowed(remote, 'Mute')) return;
            // Jellyfin reports IsMuted independently of VolumeLevel — a
            // session can be muted at vol 50. Read the mirrored isMuted flag,
            // not volume===0. Then patch optimistically so the icon doesn't
            // wait for the next PlaybackProgress frame to settle.
            const wasMuted = useRemoteTargetStore.getState().mirrored.playState.isMuted;
            peerDispatcher.setMute(remote, !wasMuted);
            useRemoteTargetStore.getState().actions.patchPlayState({ isMuted: !wasMuted });
            return;
        }
        storeActions.mediaToggleMute();
    }, [getRemoteCtx, remoteCmdAllowed, storeActions]);

    const mediaTogglePlayPause = useCallback(() => {
        logger.debug('Media toggle play pause');

        const remote = getRemoteCtx();
        if (remote) {
            const wasPaused = useRemoteTargetStore.getState().mirrored.playState.isPaused;
            // D4: send an ABSOLUTE pause/resume rather than the relative
            // `togglePause` verb. On the QoS-0 MQTT lane a duplicate/replayed
            // frame would double-toggle a relative verb back to the original
            // state while our optimistic mirror (patched once, absolutely)
            // disagrees. pause()/unpause() are idempotent on both lanes, so a
            // dup is a no-op and controller + target stay in sync.
            if (wasPaused) peerDispatcher.unpause(remote);
            else peerDispatcher.pause(remote);
            useRemoteTargetStore.getState().actions.setPaused(!wasPaused);
            return;
        }
        storeActions.mediaTogglePlayPause();
    }, [getRemoteCtx, storeActions]);

    const moveSelectedTo = useCallback(
        (items: QueueSong[], edge: 'bottom' | 'top', uniqueId: string) => {
            logger.debug('Moved selected to', { edge, items, uniqueId });

            storeActions.moveSelectedTo(items, uniqueId, edge);
        },
        [storeActions],
    );

    const moveSelectedToBottom = useCallback(
        (items: QueueSong[]) => {
            logger.debug('Moved selected to bottom', { items });

            storeActions.moveSelectedToBottom(items);
        },
        [storeActions],
    );

    const moveSelectedToNext = useCallback(
        (items: QueueSong[]) => {
            logger.debug('Moved selected to next', { items });

            storeActions.moveSelectedToNext(items);
        },
        [storeActions],
    );

    const moveSelectedToTop = useCallback(
        (items: QueueSong[]) => {
            logger.debug('Moved selected to top', { items });

            storeActions.moveSelectedToTop(items);
        },
        [storeActions],
    );

    const setVolume = useCallback(
        (volume: number) => {
            logger.debug('Set volume', { volume });
            const remote = getRemoteCtx();
            if (remote) {
                // J4: skip when the Jellyfin target doesn't accept SetVolume.
                if (!remoteCmdAllowed(remote, 'SetVolume')) return;
                peerDispatcher.setVolume(remote, volume);
                useRemoteTargetStore.getState().actions.patchPlayState({
                    volume: Math.max(0, Math.min(100, Math.round(volume))),
                });
                return;
            }
            storeActions.setVolume(volume);
        },
        [getRemoteCtx, remoteCmdAllowed, storeActions],
    );

    const setRepeat = useCallback(
        (repeat: PlayerRepeat) => {
            logger.debug('Set repeat', { repeat });

            const remote = getRemoteCtx();
            if (remote) {
                // J4: skip when the Jellyfin target doesn't accept SetRepeatMode.
                if (!remoteCmdAllowed(remote, 'SetRepeatMode')) return;
                const jf = playerRepeatToJellyfin(repeat);
                // peerDispatcher.setRepeat takes the compact PeerRepeatMode
                // (the Jellyfin string is re-derived inside its jellyfin lane).
                peerDispatcher.setRepeat(remote, jellyfinToPeerRepeat(jf));
                useRemoteTargetStore.getState().actions.patchPlayState({ repeatMode: jf });
                return;
            }
            storeActions.setRepeat(repeat);
        },
        [getRemoteCtx, remoteCmdAllowed, storeActions],
    );

    const setShuffle = useCallback(
        (shuffle: PlayerShuffle) => {
            logger.debug('Set shuffle', { shuffle });

            const remote = getRemoteCtx();
            if (remote) {
                // J4: skip when the Jellyfin target doesn't accept SetShuffleQueue.
                if (!remoteCmdAllowed(remote, 'SetShuffleQueue')) return;
                const on = shuffle === PlayerShuffle.TRACK;
                peerDispatcher.setShuffle(remote, on);
                useRemoteTargetStore.getState().actions.patchPlayState({ shuffle: on });
                return;
            }
            storeActions.setShuffle(shuffle);
        },
        [getRemoteCtx, remoteCmdAllowed, storeActions],
    );

    const shuffle = useCallback(() => {
        logger.debug('Shuffle');

        storeActions.shuffle();
    }, [storeActions]);

    const shuffleAll = useCallback(() => {
        logger.debug('Shuffle all');

        storeActions.shuffleAll();
    }, [storeActions]);

    const shuffleSelected = useCallback(
        (items: QueueSong[]) => {
            logger.debug('Shuffle selected', { items });

            storeActions.shuffleSelected(items);
        },
        [storeActions],
    );

    const toggleRepeat = useCallback(() => {
        logger.debug('Toggle repeat');

        const remote = getRemoteCtx();
        if (remote) {
            // J4: skip when the Jellyfin target doesn't accept SetRepeatMode.
            if (!remoteCmdAllowed(remote, 'SetRepeatMode')) return;
            const current = useRemoteTargetStore.getState().mirrored.playState.repeatMode;
            const next = nextJellyfinRepeat(current);
            peerDispatcher.setRepeat(remote, jellyfinToPeerRepeat(next));
            useRemoteTargetStore.getState().actions.patchPlayState({ repeatMode: next });
            return;
        }
        storeActions.toggleRepeat();
    }, [getRemoteCtx, remoteCmdAllowed, storeActions]);

    const toggleShuffle = useCallback(() => {
        logger.debug('Toggle shuffle');

        const remote = getRemoteCtx();
        if (remote) {
            // J4: skip when the Jellyfin target doesn't accept SetShuffleQueue.
            if (!remoteCmdAllowed(remote, 'SetShuffleQueue')) return;
            const isShuffled = useRemoteTargetStore.getState().mirrored.playState.shuffle;
            peerDispatcher.setShuffle(remote, !isShuffled);
            useRemoteTargetStore.getState().actions.patchPlayState({ shuffle: !isShuffled });
            return;
        }
        storeActions.toggleShuffle();
    }, [getRemoteCtx, remoteCmdAllowed, storeActions]);

    const contextValue: PlayerContext = useMemo(
        () => ({
            addToQueueByData,
            addToQueueByFetch,
            addToQueueByListQuery,
            clearQueue,
            clearSelected,
            decreaseVolume,
            getQueue,
            increaseVolume,
            mediaNext,
            mediaPause,
            mediaPlay,
            mediaPlayByIndex,
            mediaPrevious,
            mediaSeekToTimestamp,
            mediaSkipBackward,
            mediaSkipForward,
            mediaStop,
            mediaToggleMute,
            mediaTogglePlayPause,
            moveSelectedTo,
            moveSelectedToBottom,
            moveSelectedToNext,
            moveSelectedToTop,
            setQueue,
            setRepeat,
            setShuffle,
            setSpeed,
            setVolume,
            shuffle,
            shuffleAll,
            shuffleSelected,
            toggleRepeat,
            toggleShuffle,
        }),
        [
            addToQueueByData,
            addToQueueByFetch,
            addToQueueByListQuery,
            clearQueue,
            clearSelected,
            decreaseVolume,
            getQueue,
            increaseVolume,
            mediaNext,
            mediaPause,
            mediaPlay,
            mediaPlayByIndex,
            mediaPrevious,
            mediaSeekToTimestamp,
            mediaSkipBackward,
            mediaSkipForward,
            mediaStop,
            mediaToggleMute,
            mediaTogglePlayPause,
            moveSelectedTo,
            moveSelectedToBottom,
            moveSelectedToNext,
            moveSelectedToTop,
            setQueue,
            setRepeat,
            setShuffle,
            setSpeed,
            setVolume,
            shuffle,
            shuffleAll,
            shuffleSelected,
            toggleRepeat,
            toggleShuffle,
        ],
    );

    return <PlayerContext.Provider value={contextValue}>{children}</PlayerContext.Provider>;
};

export const usePlayer = () => {
    return useContext(PlayerContext);
};

/**
 * Fetches the songs from the server
 * @param queryClient - The query client to use to fetch the data
 * @param serverId - The library id to use to fetch the data
 * @param type - The type of the item to add to the queue
 * @param args - The arguments to use to fetch the data
 * @returns The songs to add to the queue
 */
export async function fetchSongsByItemType(
    queryClient: QueryClient,
    serverId: string,
    args: {
        id: string[];
        itemType: LibraryItem;
        params?: Record<string, any>;
    },
) {
    try {
        return await fetchSongsByItemTypeRemote(queryClient, serverId, args);
    } catch (err) {
        // Server unreachable (the headline case: playing an "available
        // offline" item while actually offline). Answer from the local cache
        // when it can satisfy the same contract; otherwise keep the original
        // error so the caller's toast explains what happened.
        const local = await resolveSongsByItemTypeLocal({ id: args.id, itemType: args.itemType });
        if (local && local.length > 0) {
            console.info('[offline-media] play-by-fetch served from cache after network failure', {
                count: local.length,
                itemType: args.itemType,
            });
            return local;
        }
        throw err;
    }
}

async function fetchSongsByItemTypeRemote(
    queryClient: QueryClient,
    serverId: string,
    args: {
        id: string[];
        itemType: LibraryItem;
        params?: Record<string, any>;
    },
) {
    const songs: Song[] = [];

    switch (args.itemType) {
        case LibraryItem.ALBUM: {
            const albumSongsResponse = await getAlbumSongsById({
                id: args.id,
                query: args.params,
                queryClient,
                serverId,
            });
            songs.push(...albumSongsResponse.items);
            break;
        }

        case LibraryItem.ALBUM_ARTIST: {
            const albumArtistSongsResponse = await getAlbumArtistSongsById({
                id: args.id,
                query: args.params,
                queryClient,
                serverId,
            });
            songs.push(...albumArtistSongsResponse.items);
            break;
        }

        case LibraryItem.ARTIST: {
            const artistSongsResponse = await getAlbumArtistSongsById({
                id: args.id,
                query: args.params,
                queryClient,
                serverId,
            });
            songs.push(...artistSongsResponse.items);
            break;
        }

        case LibraryItem.FOLDER: {
            const folderSongsResponse = await getSongsByFolder({
                id: args.id,
                query: args.params,
                queryClient,
                serverId,
            });
            songs.push(...folderSongsResponse.items);
            break;
        }

        case LibraryItem.GENRE: {
            const genreSongsResponse = await getGenreSongsById({
                id: args.id,
                query: args.params,
                queryClient,
                serverId,
            });
            songs.push(...genreSongsResponse.items);
            break;
        }

        case LibraryItem.PLAYLIST: {
            const promises: Promise<PlaylistSongListResponse>[] = [];

            for (const id of args.id) {
                promises.push(
                    getPlaylistSongsById({
                        id,
                        query: args.params,
                        queryClient,
                        serverId,
                    }),
                );
            }

            const results = await Promise.all(promises);
            songs.push(...results.flatMap((r) => r.items));
            break;
        }

        // Explicit song ids — pinned songs on the homepage, play-by-id.
        // Without this case the switch fell through and "play" on a pinned
        // song silently queued nothing (device, 2026-06-11).
        case LibraryItem.SONG: {
            const songsResponse = await getSongsByIds({
                id: args.id,
                queryClient,
                serverId,
            });
            songs.push(...songsResponse.items);
            break;
        }
    }

    return songs;
}

export const useIsPlayerFetching = () => {
    const playerFetchCount = useIsFetching({ queryKey: queryKeys.player.fetch() });

    return playerFetchCount > 0;
};
