// Pure-function tests for the Jellyfin response normalizer. These pin the
// MusicBrainz id mapping for songs, which feeds Discord RPC deep-links and the
// home feature-card dedup key (both consume `mbzRecordingId` / `mbzTrackId`).

import { describe, expect, it } from 'vitest';
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
