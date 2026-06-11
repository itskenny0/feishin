// Pure-function tests for the Jellyfin response normalizer. These pin the
// MusicBrainz id mapping for songs, which feeds Discord RPC deep-links and the
// home feature-card dedup key (both consume `mbzRecordingId` / `mbzTrackId`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { jfNormalize } from '/@/shared/api/jellyfin/jellyfin-normalize';
import { jfType } from '/@/shared/api/jellyfin/jellyfin-types';
import { ServerListItem, ServerType } from '/@/shared/types/types';

type JfSong = z.infer<typeof jfType._response.song>;

const server: ServerListItem = {
    credential: 'cred',
    id: 'srv1',
    name: 'Test',
    type: ServerType.JELLYFIN,
    url: 'http://localhost',
    userId: 'user1',
    username: 'tester',
};

const baseSong = (overrides: Partial<JfSong> = {}): JfSong =>
    ({
        Album: 'Album',
        AlbumArtist: 'Artist',
        AlbumArtists: [{ Id: 'aa1', Name: 'Artist' }],
        AlbumId: 'alb1',
        AlbumPrimaryImageTag: '',
        ArtistItems: [{ Id: 'a1', Name: 'Artist' }],
        Artists: ['Artist'],
        BackdropImageTags: [],
        ChannelId: null,
        DateCreated: '2020-01-01T00:00:00.000Z',
        ExternalUrls: [],
        GenreItems: [],
        Genres: [],
        Id: 'song1',
        ImageBlurHashes: {},
        ImageTags: {},
        IndexNumber: 1,
        IsFolder: false,
        LocationType: 'FileSystem',
        MediaSources: [],
        MediaType: 'Audio',
        Name: 'Song',
        ParentIndexNumber: 1,
        RunTimeTicks: 0,
        ServerId: 'srv1',
        Type: 'Audio',
        ...overrides,
    }) as JfSong;

type JfPlaylist = z.infer<typeof jfType._response.playlist>;
type JfPlaylistList = z.infer<typeof jfType._response.playlistList>;

const basePlaylist = (overrides: Partial<JfPlaylist> = {}): JfPlaylist =>
    ({
        BackdropImageTags: [],
        ChannelId: null,
        ChildCount: 3,
        DateCreated: '2020-01-01T00:00:00.000Z',
        GenreItems: [],
        Genres: [],
        Id: 'pl1',
        ImageBlurHashes: {},
        ImageTags: {},
        IsFolder: true,
        LocationType: 'FileSystem',
        MediaType: 'Audio',
        Name: 'Playlist',
        RunTimeTicks: 0,
        ServerId: 'srv1',
        Type: 'Playlist',
        UserData: {},
        ...overrides,
    }) as JfPlaylist;

const playlistListBody = (items: JfPlaylist[], totalRecordCount: number): JfPlaylistList =>
    ({
        Items: items,
        StartIndex: 0,
        TotalRecordCount: totalRecordCount,
    }) as JfPlaylistList;

describe('jfNormalize.playlistList smart/non-audio filtering', () => {
    it('keeps only audio playlists and subtracts the dropped count from the total', () => {
        const body = playlistListBody(
            [
                basePlaylist({ Id: 'audio1', MediaType: 'Audio' }),
                basePlaylist({ Id: 'video1', MediaType: 'Video' }),
                basePlaylist({ Id: 'audio2', MediaType: 'Audio' }),
            ],
            // Server reports all 3 as the total; one is non-audio.
            3,
        );

        const result = jfNormalize.playlistList(body, server);

        expect(result.items.map((p) => p.id)).toEqual(['audio1', 'audio2']);
        // 3 reported - 1 dropped in this page = 2, matching items.length.
        expect(result.totalRecordCount).toBe(2);
        expect(result.totalRecordCount).toBe(result.items.length);
    });

    it('passes through an all-audio page unchanged', () => {
        const body = playlistListBody([basePlaylist({ Id: 'a' }), basePlaylist({ Id: 'b' })], 2);

        const result = jfNormalize.playlistList(body, server);

        expect(result.items).toHaveLength(2);
        expect(result.totalRecordCount).toBe(2);
    });

    it('never produces a negative total when the dropped count exceeds the reported total', () => {
        // Defensive: a server under-reporting TotalRecordCount must not yield a
        // negative count (which would break table row allocation).
        const body = playlistListBody([basePlaylist({ MediaType: 'Video' })], 0);

        const result = jfNormalize.playlistList(body, server);

        expect(result.items).toHaveLength(0);
        expect(result.totalRecordCount).toBe(0);
    });
});

describe('jfNormalize.song MusicBrainz ids', () => {
    it('maps MusicBrainzRecording to mbzRecordingId and MusicBrainzTrack to mbzTrackId', () => {
        const result = jfNormalize.song(
            baseSong({
                ProviderIds: {
                    MusicBrainzRecording: 'rec-123',
                    MusicBrainzTrack: 'trk-456',
                },
            }),
            server,
        );

        expect(result.mbzRecordingId).toBe('rec-123');
        expect(result.mbzTrackId).toBe('trk-456');
    });

    it('maps MusicBrainzRecording independently when no track id is present', () => {
        const result = jfNormalize.song(
            baseSong({ ProviderIds: { MusicBrainzRecording: 'rec-only' } }),
            server,
        );

        expect(result.mbzRecordingId).toBe('rec-only');
        expect(result.mbzTrackId).toBeNull();
    });

    it('falls back to null when ProviderIds is absent', () => {
        const result = jfNormalize.song(baseSong(), server);

        expect(result.mbzRecordingId).toBeNull();
        expect(result.mbzTrackId).toBeNull();
    });
});

// Freeze regression (2026-06-11): a /Sessions NowPlayingItem carries no
// MediaSources, so a remote-target controller re-normalizing the mirrored
// track on every 2Hz frame logged "no media sources" once PER FRAME with the
// full item object. The warn is now rate-limited to once per item id.
describe('jfNormalize.song — "no media sources" warn is rate-limited per id', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns exactly once across many re-normalizations of the same id', () => {
        const item = baseSong({ Id: 'freeze-track', MediaSources: [] });
        for (let i = 0; i < 100; i += 1) {
            jfNormalize.song(item, server);
        }
        const noMedia = warnSpy.mock.calls.filter((c) => String(c[0]).includes('no media sources'));
        expect(noMedia).toHaveLength(1);
    });

    it('still warns for a different track id', () => {
        jfNormalize.song(baseSong({ Id: 'track-a', MediaSources: [] }), server);
        jfNormalize.song(baseSong({ Id: 'track-b', MediaSources: [] }), server);
        const noMedia = warnSpy.mock.calls.filter((c) => String(c[0]).includes('no media sources'));
        // track-a may already be in the warned-set from the prior test, but
        // track-b is fresh — assert at least the distinct-id one fired.
        expect(noMedia.length).toBeGreaterThanOrEqual(1);
        expect(
            warnSpy.mock.calls.some(
                (c) => String(c[0]).includes('no media sources') && (c[1] as any)?.Id === 'track-b',
            ),
        ).toBe(true);
    });
});
