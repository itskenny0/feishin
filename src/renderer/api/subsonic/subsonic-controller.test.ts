// Controller-level tests for the Subsonic backend. The HTTP client is mocked so
// each test pins how server responses are combined into the domain result.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ssApiClient } from '/@/renderer/api/subsonic/subsonic-api';
import { SubsonicController } from '/@/renderer/api/subsonic/subsonic-controller';
import {
    AlbumListSort,
    ServerListItemWithCredential,
    ServerType,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

vi.mock('/@/renderer/api/subsonic/subsonic-api', () => ({
    contract: {},
    ssApiClient: vi.fn(),
}));
vi.mock('/@/renderer/features/player/components/audio-players', () => ({
    getDefaultTranscodingProfiles: vi.fn(),
    getDirectPlayProfiles: vi.fn(),
}));

const server = {
    credential: 'u=tester&s=salt&t=token',
    id: 'srv1',
    name: 'Test',
    type: ServerType.SUBSONIC,
    url: 'http://ss.local',
    userId: 'tester',
    username: 'tester',
} as ServerListItemWithCredential;

const apiClientProps = { server, serverId: server.id };

const mockClient = (client: Record<string, unknown>) => {
    vi.mocked(ssApiClient).mockReturnValue(client as unknown as ReturnType<typeof ssApiClient>);
};

const songEntry = (id: string) => ({
    albumArtists: [],
    artists: [],
    contentType: 'audio/flac',
    created: '2020-01-01T00:00:00.000Z',
    discNumber: 1,
    id,
    isDir: false,
    isVideo: false,
    parent: 'p',
    path: `${id}.flac`,
    size: 1,
    suffix: 'flac',
    title: id,
    type: 'music',
});

describe('SubsonicController.getAlbumListCount', () => {
    beforeEach(() => vi.mocked(ssApiClient).mockReset());

    // One unreachable artist must not wipe the albums already counted for the
    // others; getAlbumList skips it the same way.
    it('skips an artist that fails to load instead of resetting the total', async () => {
        const albumsByArtist: Record<string, number> = { a1: 2, a3: 3 };
        const getArtist = vi.fn(async ({ query }: { query: { id: string } }) =>
            query.id in albumsByArtist
                ? {
                      body: { artist: { album: Array(albumsByArtist[query.id]).fill({}) } },
                      status: 200,
                  }
                : { body: {}, status: 70 },
        );
        mockClient({ getArtist });

        const count = await SubsonicController.getAlbumListCount({
            apiClientProps,
            query: {
                artistIds: ['a1', 'a2', 'a3'],
                sortBy: AlbumListSort.NAME,
                sortOrder: SortOrder.ASC,
            },
        });

        expect(count).toBe(5);
    });
});

describe('SubsonicController.getSongListCount', () => {
    beforeEach(() => vi.mocked(ssApiClient).mockReset());

    it('counts every song of the requested albums and artists', async () => {
        const getAlbum = vi.fn(async ({ query }: { query: { id: string } }) => ({
            body: { album: { song: [songEntry(`${query.id}-1`), songEntry(`${query.id}-2`)] } },
            status: 200,
        }));
        const getArtist = vi.fn(async () => ({
            body: { artist: { album: [{ id: 'ar-al1' }, { id: 'ar-al2' }] } },
            status: 200,
        }));
        mockClient({ getAlbum, getArtist });

        const count = await SubsonicController.getSongListCount({
            apiClientProps,
            query: {
                albumIds: ['al1'],
                artistIds: ['ar1'],
                sortBy: SongListSort.ALBUM,
                sortOrder: SortOrder.ASC,
            },
        });

        expect(getAlbum).toHaveBeenCalledTimes(3);
        expect(count).toBe(6);
    });
});

describe('SubsonicController.replacePlaylist', () => {
    beforeEach(() => vi.mocked(ssApiClient).mockReset());

    it('clears the playlist by index and adds the new songs', async () => {
        const getPlaylist = vi.fn(async () => ({
            body: {
                playlist: {
                    duration: 0,
                    entry: [songEntry('s1'), songEntry('s2')],
                    id: 'pl1',
                    name: 'Mix',
                    songCount: 2,
                },
            },
            status: 200,
        }));
        const updatePlaylist = vi.fn(async () => ({ body: {}, status: 200 }));
        mockClient({ getPlaylist, updatePlaylist });

        await SubsonicController.replacePlaylist({
            apiClientProps,
            body: { songId: ['n1', 'n2'] },
            query: { id: 'pl1' },
        });

        expect(updatePlaylist).toHaveBeenNthCalledWith(1, {
            query: { playlistId: 'pl1', songIndexToRemove: ['1', '0'] },
        });
        expect(updatePlaylist).toHaveBeenNthCalledWith(2, {
            query: { playlistId: 'pl1', songIdToAdd: ['n1', 'n2'] },
        });
    });
});
