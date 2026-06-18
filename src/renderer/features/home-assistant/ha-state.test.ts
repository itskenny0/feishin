import { describe, expect, it } from 'vitest';

import { buildHaState } from './ha-state';

import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const song = {
    album: 'A',
    albumArtists: [{ name: 'AlbumArtist' }],
    artists: [{ name: 'Artist' }],
    duration: 200000,
    imageUrl: 'http://x/art.jpg',
    name: 'Song',
} as any;

describe('buildHaState', () => {
    it('maps a playing track', () => {
        const s = buildHaState({
            artUrl: 'http://x/art.jpg',
            current: song,
            muted: false,
            position: 12.5,
            repeat: PlayerRepeat.ALL,
            shuffle: PlayerShuffle.TRACK,
            status: PlayerStatus.PLAYING,
            volume: 80,
        });
        expect(s).toMatchObject({
            album: 'A',
            artist: 'Artist',
            artUrl: 'http://x/art.jpg',
            duration: 200,
            muted: false,
            position: 12,
            repeat: 'all',
            shuffle: true,
            state: 'playing',
            title: 'Song',
            volume: 80,
        });
    });

    it('falls back to album artists when track artists are absent', () => {
        const s = buildHaState({
            artUrl: 'http://x/art.jpg',
            current: { ...song, artists: [] },
            muted: false,
            position: 0,
            repeat: PlayerRepeat.NONE,
            shuffle: PlayerShuffle.NONE,
            status: PlayerStatus.PLAYING,
            volume: 10,
        });
        expect(s.artist).toBe('AlbumArtist');
    });

    it('reports idle with no current song', () => {
        const s = buildHaState({
            artUrl: 'http://x/art.jpg',
            current: undefined,
            muted: false,
            position: 0,
            repeat: PlayerRepeat.NONE,
            shuffle: PlayerShuffle.NONE,
            status: PlayerStatus.PAUSED,
            volume: 50,
        });
        expect(s.state).toBe('idle');
        expect(s.title).toBe('');
        expect(s.repeat).toBe('off');
        expect(s.shuffle).toBe(false);
    });

    it('reports paused when a song is loaded but not playing', () => {
        const s = buildHaState({
            artUrl: 'http://x/art.jpg',
            current: song,
            muted: true,
            position: 5,
            repeat: PlayerRepeat.ONE,
            shuffle: PlayerShuffle.NONE,
            status: PlayerStatus.PAUSED,
            volume: 0,
        });
        expect(s.state).toBe('paused');
        expect(s.repeat).toBe('one');
        expect(s.muted).toBe(true);
    });
});
