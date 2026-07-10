// Streaming enumeration of an offline target's songs. Yields songs in PAGES as
// they arrive so the download pool can start on page 1 instead of waiting for
// the whole (potentially huge) playlist to enumerate. Album/song targets
// resolve in a single page; playlist/artist/genre targets page through.
//
// Error policy: a FIRST-page error throws (nothing was enumerated — the target
// fails). A later-page error ends the stream cleanly (the pages already yielded
// remain queued — the target ends `partial`, not `error`).

import type { Song } from '/@/shared/types/domain-types';

import type { OfflineTargetRow } from '../types';

import { api } from '/@/renderer/api';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

const TAG = '[offline-media]';
const ENUMERATE_PAGE = 500;

const fetchPage = async (
    entityType: OfflineTargetRow['EntityType'],
    entityId: string,
    apiClientProps: { serverId: string; signal?: AbortSignal },
    startIndex: number,
): Promise<Song[]> => {
    if (entityType === 'playlist') {
        const page = await api.controller.getPlaylistSongList({
            apiClientProps,
            query: { id: entityId, limit: ENUMERATE_PAGE, startIndex },
        });
        return page?.items ?? [];
    }
    const page = await api.controller.getSongList({
        apiClientProps,
        query: {
            albumArtistIds: entityType === 'artist' ? [entityId] : undefined,
            genreIds: entityType === 'genre' ? [entityId] : undefined,
            limit: ENUMERATE_PAGE,
            sortBy: SongListSort.ALBUM,
            sortOrder: SortOrder.ASC,
            startIndex,
        },
    });
    return page?.items ?? [];
};

export async function* streamTargetSongs(
    target: Pick<OfflineTargetRow, 'EntityId' | 'EntityType' | 'ServerId'>,
    signal?: AbortSignal,
): AsyncGenerator<Song[]> {
    const { EntityId: entityId, EntityType: entityType, ServerId: serverId } = target;
    const apiClientProps = { serverId, signal };

    if (entityType === 'album') {
        const album = await api.controller.getAlbumDetail({
            apiClientProps,
            query: { id: entityId },
        });
        const items = album?.songs ?? [];
        if (items.length) yield items;
        return;
    }

    if (entityType === 'song') {
        const song = await api.controller.getSongDetail({
            apiClientProps,
            query: { id: entityId },
        });
        if (song) yield [song];
        return;
    }

    // playlist / artist / genre — page through.
    let startIndex = 0;
    let firstPage = true;
    while (true) {
        if (signal?.aborted) return;
        let items: Song[];
        try {
            items = await fetchPage(entityType, entityId, apiClientProps, startIndex);
        } catch (err) {
            if (firstPage) throw err; // nothing enumerated → target fails
            console.warn(`${TAG} enumerate: page error, ending stream`, {
                entityId,
                err,
                startIndex,
            });
            return; // later page → keep what we have
        }
        firstPage = false;
        if (items.length) yield items;
        if (items.length < ENUMERATE_PAGE) return;
        startIndex += ENUMERATE_PAGE;
    }
}
