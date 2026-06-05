import { useCallback } from 'react';

import {
    playAlbumFromItemListControl,
    playArtistFromItemListControl,
    playSongFromItemListControl,
} from '/@/renderer/components/item-list/helpers/play-row-from-list';
import { ItemTableListInnerColumn } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { useIsActiveRow } from '/@/renderer/components/item-list/item-table-list/item-table-list-context';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { usePlayerStoreBase } from '/@/renderer/store';
import {
    Album,
    AlbumArtist,
    Artist,
    LibraryItem,
    QueueSong,
    Song,
} from '/@/shared/types/domain-types';
import { Play, PlayerStatus } from '/@/shared/types/types';

export const supportsRowPlayControls = (itemType: LibraryItem) =>
    itemType === LibraryItem.ALBUM ||
    itemType === LibraryItem.ALBUM_ARTIST ||
    itemType === LibraryItem.ARTIST ||
    itemType === LibraryItem.PLAYLIST_SONG ||
    itemType === LibraryItem.SONG;

export const supportsTrackNumberRowPlayControls = (itemType: LibraryItem) =>
    itemType === LibraryItem.PLAYLIST_SONG ||
    itemType === LibraryItem.QUEUE_SONG ||
    itemType === LibraryItem.SONG;

export const hasPlayableRowItem = (
    itemType: LibraryItem,
    items: { album: Album; artist: AlbumArtist | Artist; song: QueueSong },
) => {
    switch (itemType) {
        case LibraryItem.ALBUM:
            return !!items.album?.id;
        case LibraryItem.ALBUM_ARTIST:
        case LibraryItem.ARTIST:
            return !!items.artist?.id;
        default:
            return !!items.song;
    }
};

export const useRowPlayControl = (props: ItemTableListInnerColumn) => {
    const player = usePlayer();
    const rowItem = props.getRowItem?.(props.rowIndex) ?? props.data[props.rowIndex];
    const song = rowItem as QueueSong;
    const album = rowItem as Album;
    const artist = rowItem as AlbumArtist | Artist;

    const isActiveFromRow = useIsActiveRow(song?.id, song?._uniqueId);

    // Whether this row is the active (currently-loaded) one. For SONG-like rows
    // this comes from the per-row active-row context (no global subscription).
    // For ALBUM/ALBUM_ARTIST/ARTIST it has to be derived from the current song,
    // but we collapse it to a primitive `boolean` inside the store selector so
    // Zustand bails out for every row whose active-ness didn't change — a track
    // change no longer re-renders the whole visible index column.
    const itemType = props.itemType;
    const albumId = album?.id;
    const artistId = artist?.id;

    const isActiveFromStore = usePlayerStoreBase((state): boolean => {
        if (
            itemType !== LibraryItem.ALBUM &&
            itemType !== LibraryItem.ALBUM_ARTIST &&
            itemType !== LibraryItem.ARTIST
        ) {
            return false;
        }
        const currentSong = state.getCurrentSong();
        switch (itemType) {
            case LibraryItem.ALBUM:
                return !!albumId && currentSong?.albumId === albumId;
            case LibraryItem.ALBUM_ARTIST:
                return (
                    !!artistId &&
                    !!currentSong?.albumArtists?.some(
                        (relatedArtist) => relatedArtist.id === artistId,
                    )
                );
            case LibraryItem.ARTIST:
                return (
                    !!artistId &&
                    !!currentSong?.artists?.some((relatedArtist) => relatedArtist.id === artistId)
                );
            default:
                return false;
        }
    });

    const isActive =
        itemType === LibraryItem.ALBUM ||
        itemType === LibraryItem.ALBUM_ARTIST ||
        itemType === LibraryItem.ARTIST
            ? isActiveFromStore
            : isActiveFromRow;

    // Only the active row subscribes to the play/pause status; inactive rows
    // get a constant `false`, so a play/pause toggle re-renders just that one
    // row instead of every visible play-control cell.
    const isPlaying = usePlayerStoreBase((state): boolean =>
        isActive ? state.player.status === PlayerStatus.PLAYING : false,
    );

    const showPlayControls =
        supportsRowPlayControls(props.itemType) &&
        hasPlayableRowItem(props.itemType, { album, artist, song });

    const handlePlay = useCallback(
        (playType: Play) => {
            if (props.itemType === LibraryItem.ALBUM) {
                if (!album?.id) {
                    return;
                }

                playAlbumFromItemListControl({
                    album,
                    meta: { playType },
                    player,
                });
                return;
            }

            if (
                props.itemType === LibraryItem.ALBUM_ARTIST ||
                props.itemType === LibraryItem.ARTIST
            ) {
                if (!artist?.id) {
                    return;
                }

                playArtistFromItemListControl({
                    artist,
                    itemType: props.itemType,
                    meta: { playType },
                    player,
                });
                return;
            }

            if (!song) {
                return;
            }

            playSongFromItemListControl({
                item: song as Song,
                meta: { playType, singleSongOnly: true },
                player,
            });
        },
        [album, artist, player, props.itemType, song],
    );

    return {
        album,
        artist,
        handlePlay,
        isActive,
        isPlaying,
        showPlayControls,
        song,
    };
};
