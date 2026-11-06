// Controller-level tests for the Jellyfin backend. The HTTP client is mocked so
// each test pins how a server response is shaped into the domain result.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { jfApiClient } from '/@/renderer/api/jellyfin/jellyfin-api';
import { JellyfinController } from '/@/renderer/api/jellyfin/jellyfin-controller';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { replacePathPrefix } from '/@/shared/api/utils';
import {
    ServerListItemWithCredential,
    ServerType,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

vi.mock('/@/renderer/api/jellyfin/jellyfin-api', () => ({
    createAuthHeader: () => 'MediaBrowser Client="Feishin"',
    jfApiClient: vi.fn(),
}));
vi.mock('/@/renderer/features/radio/store/radio-store', () => ({
    useRadioStore: { getState: vi.fn() },
}));
vi.mock('/@/renderer/store/player.store', () => ({
    isShuffleEnabled: vi.fn(),
    usePlayerStoreBase: { getState: vi.fn() },
}));

const server = {
    credential: 'token',
    id: 'srv1',
    name: 'Test',
    type: ServerType.JELLYFIN,
    url: 'http://jf.local',
    userId: 'user1',
    username: 'tester',
} as ServerListItemWithCredential;

const apiClientProps = { server, serverId: server.id };

const mockClient = (client: Record<string, unknown>) => {
    vi.mocked(jfApiClient).mockReturnValue(client as unknown as ReturnType<typeof jfApiClient>);
};

const audioItem = (id: string, albumId: string) => ({
    Album: albumId,
    AlbumArtists: [],
    AlbumId: albumId,
    ArtistItems: [],
    Id: id,
    MediaSources: [{ Container: 'flac', MediaStreams: [], Path: `/music/${id}.flac`, Size: 1 }],
    Name: id,
    RunTimeTicks: 0,
    Type: 'Audio',
});

describe('JellyfinController.getFolder', () => {
    beforeEach(() => vi.mocked(jfApiClient).mockReset());

    // Path replacement is applied once, at display time (resolveSongPath). The
    // controller must hand back the server path untouched, or folder rows in
    // the Path column get the prefix applied twice.
    it('returns folder paths unreplaced even when path replacement is configured', async () => {
        const getFolder = vi.fn(async () => ({
            body: {
                Items: [
                    {
                        Id: 'sub1',
                        Name: 'Sub',
                        ParentId: 'f1',
                        Path: '/music/Artist/Sub',
                        Type: 'Folder',
                    },
                ],
                TotalRecordCount: 1,
            },
            status: 200,
        }));
        mockClient({ getFolder });

        const context = { pathReplace: '/music', pathReplaceWith: '/mnt/music' };
        const result = await JellyfinController.getFolder!({
            apiClientProps,
            context,
            query: { id: 'f1', sortBy: SongListSort.NAME, sortOrder: SortOrder.ASC },
        });

        const path = result.children!.folders[0].path!;
        expect(path).toBe('/music/Artist/Sub');
        expect(replacePathPrefix(path, context.pathReplace, context.pathReplaceWith)).toBe(
            '/mnt/music/Artist/Sub',
        );
    });
});

describe('JellyfinController.getSongList', () => {
    beforeEach(() => vi.mocked(jfApiClient).mockReset());

    // Jellyfin's AlbumIds filter also matches OTHER albums that share a name, so
    // the controller drops songs whose AlbumId was not requested. That must hold
    // for the batched (> 50 album ids) path too.
    it('drops songs from same-named albums when album ids are batched', async () => {
        const getSongList = vi.fn(async ({ query }: { query: { AlbumIds: string } }) => {
            const [firstId] = query.AlbumIds.split(',');
            const items = [audioItem(`song-${firstId}`, firstId), audioItem('stray', 'other')];
            return { body: { Items: items, TotalRecordCount: items.length }, status: 200 };
        });
        mockClient({ getSongList });

        const albumIds = Array.from({ length: 51 }, (_, i) => `al${i}`);
        const result = await JellyfinController.getSongList({
            apiClientProps,
            query: {
                albumIds,
                sortBy: SongListSort.ALBUM,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
        });

        expect(getSongList).toHaveBeenCalledTimes(2);
        expect(result.items.map((song) => song.id)).toEqual(['song-al0', 'song-al50']);
        expect(result.totalRecordCount).toBe(2);
    });

    it('keeps the server total when no album ids are given', async () => {
        const getSongList = vi.fn(async () => ({
            body: { Items: [audioItem('s1', 'a1')], TotalRecordCount: 1234 },
            status: 200,
        }));
        mockClient({ getSongList });

        const result = await JellyfinController.getSongList({
            apiClientProps,
            query: { limit: 1, sortBy: SongListSort.NAME, sortOrder: SortOrder.ASC, startIndex: 0 },
        });

        expect(result.items.map((song) => song.id)).toEqual(['s1']);
        expect(result.totalRecordCount).toBe(1234);
    });
});

describe('JellyfinController.scrobble', () => {
    type ScrobbleCall = (req: { body: Record<string, unknown> }) => Promise<{ status: number }>;
    const client = {
        scrobblePlaying: vi.fn<ScrobbleCall>(async () => ({ status: 204 })),
        scrobbleProgress: vi.fn<ScrobbleCall>(async () => ({ status: 204 })),
        scrobbleStopped: vi.fn<ScrobbleCall>(async () => ({ status: 204 })),
    };

    beforeEach(() => {
        vi.mocked(jfApiClient).mockReset();
        Object.values(client).forEach((fn) => fn.mockClear());
        mockClient(client);
        vi.mocked(usePlayerStoreBase.getState).mockReturnValue({
            getCurrentSong: () => ({ _uniqueId: 'q1' }),
            player: { index: 0, muted: false, volume: 40 },
            queue: { default: [], shuffled: [], songs: {} },
        } as unknown as ReturnType<typeof usePlayerStoreBase.getState>);
    });

    const scrobble = (query: {
        event?: 'pause' | 'start' | 'stop' | 'timeupdate' | 'unpause';
        submission?: boolean;
    }) =>
        JellyfinController.scrobble({
            apiClientProps,
            query: {
                id: 'song1',
                mediaType: 'song',
                playbackRate: 1,
                position: 12_345.6,
                submission: false,
                ...query,
            },
        });

    const base = {
        IsMuted: false,
        ItemId: 'song1',
        PlaylistItemId: 'q1',
        PositionTicks: 12_346,
        VolumeLevel: 40,
    };

    it('reports a submission as a paused stop', async () => {
        await scrobble({ submission: true });
        expect(client.scrobbleStopped).toHaveBeenCalledWith({
            body: expect.objectContaining({ ...base, IsPaused: true }),
        });
    });

    it('routes start and stop to their endpoints', async () => {
        await scrobble({ event: 'start' });
        await scrobble({ event: 'stop' });
        expect(client.scrobblePlaying).toHaveBeenCalledWith({
            body: expect.objectContaining(base),
        });
        expect(client.scrobbleStopped).toHaveBeenCalledWith({
            body: expect.objectContaining(base),
        });
        expect(client.scrobbleStopped.mock.calls[0]?.[0].body).not.toHaveProperty('IsPaused');
    });

    it('sends pause state with progress events', async () => {
        await scrobble({ event: 'pause' });
        await scrobble({ event: 'unpause' });
        await scrobble({ event: 'timeupdate' });
        const bodies = client.scrobbleProgress.mock.calls.map(([arg]) => arg.body);
        expect(bodies[0]).toMatchObject({ ...base, EventName: 'pause', IsPaused: true });
        expect(bodies[1]).toMatchObject({ ...base, EventName: 'unpause', IsPaused: false });
        expect(bodies[2]).toMatchObject({ ...base, EventName: 'timeupdate' });
        expect(bodies[2].IsPaused).toBeUndefined();
        expect(bodies[2].NowPlayingQueue).toBeUndefined();
    });
});
