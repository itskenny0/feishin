import { describe, expect, it } from 'vitest';

import {
    OfflineGuardSong,
    selectOfflinePlayable,
} from '/@/renderer/features/player/utils/offline-play-guard';

const song = (id: string, serverId = 'srv1'): OfflineGuardSong => ({ _serverId: serverId, id });

const availability =
    (...availableIds: string[]) =>
    (_serverId: string, songId: string) =>
        availableIds.includes(songId);

describe('selectOfflinePlayable', () => {
    it('online: always allowed and every song playable', () => {
        const songs = [song('a'), song('b')];
        const result = selectOfflinePlayable({
            isAvailable: availability(), // nothing downloaded
            online: true,
            songs,
        });
        expect(result.allowed).toBe(true);
        expect(result.playable.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('offline + all downloaded: allowed with the same songs', () => {
        const songs = [song('a'), song('b')];
        const result = selectOfflinePlayable({
            isAvailable: availability('a', 'b'),
            online: false,
            songs,
        });
        expect(result.allowed).toBe(true);
        expect(result.playable.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('offline + none downloaded: blocked', () => {
        const result = selectOfflinePlayable({
            isAvailable: availability(),
            online: false,
            songs: [song('a'), song('b')],
        });
        expect(result.allowed).toBe(false);
        expect(result.playable).toEqual([]);
    });

    it('offline + mixed: allowed, narrowed to the downloaded subset', () => {
        const songs = [song('a'), song('b'), song('c')];
        const result = selectOfflinePlayable({
            isAvailable: availability('b'),
            online: false,
            songs,
        });
        expect(result.allowed).toBe(true);
        expect(result.playable.map((s) => s.id)).toEqual(['b']);
    });

    it('offline + targeted song unavailable: blocked even if neighbours are downloaded', () => {
        const songs = [song('a'), song('b')];
        const result = selectOfflinePlayable({
            isAvailable: availability('b'), // b downloaded, a not
            online: false,
            playSongId: 'a',
            songs,
        });
        expect(result.allowed).toBe(false);
        expect(result.playable).toEqual([]);
    });

    it('offline + targeted song available: allowed', () => {
        const songs = [song('a'), song('b')];
        const result = selectOfflinePlayable({
            isAvailable: availability('a', 'b'),
            online: false,
            playSongId: 'a',
            songs,
        });
        expect(result.allowed).toBe(true);
        expect(result.playable.map((s) => s.id)).toContain('a');
    });

    it('offline + targeted id not present in the list: falls back to subset rule', () => {
        const songs = [song('a'), song('b')];
        const result = selectOfflinePlayable({
            isAvailable: availability('a'),
            online: false,
            playSongId: 'zzz', // not in songs
            songs,
        });
        // playSongId absent → no specific block; subset rule allows the
        // downloaded 'a'.
        expect(result.allowed).toBe(true);
        expect(result.playable.map((s) => s.id)).toEqual(['a']);
    });
});
