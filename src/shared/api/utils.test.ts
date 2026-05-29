// Pure-function tests for the cross-backend API helpers. These pin the feature
// gating logic (hasFeature / hasFeatureWithVersion / getFeatures version
// matching) and the path-prefix rewriter, all of which sit on hot list/sort
// paths shared by every server backend.

import { describe, expect, it } from 'vitest';

import {
    getFeatures,
    hasFeature,
    hasFeatureWithVersion,
    replacePathPrefix,
    VersionInfo,
} from '/@/shared/api/utils';
import { ServerListItem, ServerType } from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';

const server = (overrides: Partial<ServerListItem> = {}): ServerListItem => ({
    id: 'srv1',
    name: 'Test',
    type: ServerType.NAVIDROME,
    url: 'http://localhost',
    userId: null,
    username: 'tester',
    ...overrides,
});

describe('hasFeature', () => {
    it('returns false when server is null', () => {
        expect(hasFeature(null, ServerFeature.TAGS)).toBe(false);
    });

    it('returns false when server has no features map', () => {
        expect(hasFeature(server(), ServerFeature.TAGS)).toBe(false);
    });

    it('returns false when the feature is absent', () => {
        expect(hasFeature(server({ features: {} }), ServerFeature.TAGS)).toBe(false);
    });

    it('returns false when the feature array is empty', () => {
        expect(
            hasFeature(server({ features: { [ServerFeature.TAGS]: [] } }), ServerFeature.TAGS),
        ).toBe(false);
    });

    it('returns true when the feature has at least one supported version', () => {
        expect(
            hasFeature(server({ features: { [ServerFeature.TAGS]: [1] } }), ServerFeature.TAGS),
        ).toBe(true);
    });
});

describe('hasFeatureWithVersion', () => {
    it('returns false when server is null', () => {
        expect(hasFeatureWithVersion(null, ServerFeature.TAGS, 1)).toBe(false);
    });

    it('returns false when server has no features map', () => {
        expect(hasFeatureWithVersion(server(), ServerFeature.TAGS, 1)).toBe(false);
    });

    it('returns false when the requested version is not listed', () => {
        expect(
            hasFeatureWithVersion(
                server({ features: { [ServerFeature.TAGS]: [1, 2] } }),
                ServerFeature.TAGS,
                3,
            ),
        ).toBe(false);
    });

    it('returns true when the requested version is listed', () => {
        expect(
            hasFeatureWithVersion(
                server({ features: { [ServerFeature.TAGS]: [1, 2] } }),
                ServerFeature.TAGS,
                2,
            ),
        ).toBe(true);
    });
});

describe('getFeatures', () => {
    const VERSION_INFO: VersionInfo = [
        ['0.49.3', { [ServerFeature.SHARING_ALBUM_SONG]: [1] }],
        ['0.48.0', { [ServerFeature.PLAYLISTS_SMART]: [1] }],
    ];

    it('matches all features at or below the server version (descending list)', () => {
        const features = getFeatures(VERSION_INFO, '0.49.3');
        expect(features[ServerFeature.SHARING_ALBUM_SONG]).toEqual([1]);
        expect(features[ServerFeature.PLAYLISTS_SMART]).toEqual([1]);
    });

    it('matches only the newer-than-version entries when the server is mid-range', () => {
        const features = getFeatures(VERSION_INFO, '0.48.5');
        expect(features[ServerFeature.SHARING_ALBUM_SONG]).toBeUndefined();
        expect(features[ServerFeature.PLAYLISTS_SMART]).toEqual([1]);
    });

    it('matches nothing when the server is below every listed version', () => {
        expect(getFeatures(VERSION_INFO, '0.47.0')).toEqual({});
    });

    it('treats an uncoercible version string as matching everything', () => {
        const features = getFeatures(VERSION_INFO, 'not-a-version');
        expect(features[ServerFeature.SHARING_ALBUM_SONG]).toEqual([1]);
        expect(features[ServerFeature.PLAYLISTS_SMART]).toEqual([1]);
    });

    it('merges version arrays when the same feature appears in multiple entries', () => {
        const info: VersionInfo = [
            ['0.49.0', { [ServerFeature.TAGS]: [2] }],
            ['0.48.0', { [ServerFeature.TAGS]: [1] }],
        ];
        expect(getFeatures(info, '0.49.0')[ServerFeature.TAGS]).toEqual([2, 1]);
    });
});

describe('replacePathPrefix', () => {
    it('returns the path unchanged when no prefixes are supplied', () => {
        expect(replacePathPrefix('/music/song.flac')).toBe('/music/song.flac');
    });

    it('strips a matching replace prefix', () => {
        expect(replacePathPrefix('/music/song.flac', '/music')).toBe('/song.flac');
    });

    it('does not strip a non-matching replace prefix', () => {
        expect(replacePathPrefix('/music/song.flac', '/other')).toBe('/music/song.flac');
    });

    it('prepends the add prefix', () => {
        expect(replacePathPrefix('/song.flac', undefined, '/media')).toBe('/media/song.flac');
    });

    it('strips then prepends when both prefixes are given', () => {
        expect(replacePathPrefix('/music/song.flac', '/music', '/media')).toBe('/media/song.flac');
    });
});
