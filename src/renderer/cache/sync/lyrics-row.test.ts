// Pure-function tests for `toLyricsRow` — converts a fetchLocalLyrics result
// into the CachedLyrics row the lyrics sweep persists.
//
// Contract:
//  - A FullLyricsMetadata with string lyrics  → positive row, Synced:false.
//  - A FullLyricsMetadata with a synced array → positive row, Synced:true,
//    Lyrics is the JSON-stringified array.
//  - A StructuredLyric[] (Subsonic)           → positive row from the first
//    entry (StructuredLyric is FullLyricsMetadata-compatible).
//  - null / undefined / [] (no lyrics)        → NEGATIVE marker: empty Lyrics,
//    no Payload. The on-demand reader treats a Payload-less row as a miss, so
//    negatives stay transparent to on-demand internet lookup while letting the
//    sweep skip the song on its next pass.

import type { FullLyricsMetadata, StructuredLyric } from '/@/shared/types/domain-types';

import { describe, expect, it } from 'vitest';

import { toLyricsRow } from '/@/renderer/cache/sync/lyrics';

const NOW = 1000;

const meta = (lyrics: FullLyricsMetadata['lyrics']): FullLyricsMetadata => ({
    artist: 'A',
    lyrics,
    name: 'N',
    remote: false,
    source: 'server',
});

describe('toLyricsRow', () => {
    it('builds a positive unsynced row from string lyrics', () => {
        expect(toLyricsRow('s1', meta('la la la'), NOW)).toEqual({
            __cachedAt: NOW,
            Lyrics: 'la la la',
            Payload: meta('la la la'),
            SongId: 's1',
            Synced: false,
        });
    });

    it('builds a positive synced row from a synchronized array', () => {
        const m = meta([{ startMs: 0, text: 'hi' }]);
        expect(toLyricsRow('s2', m, NOW)).toEqual({
            __cachedAt: NOW,
            Lyrics: JSON.stringify([{ startMs: 0, text: 'hi' }]),
            Payload: m,
            SongId: 's2',
            Synced: true,
        });
    });

    it('builds a positive row from the first StructuredLyric entry', () => {
        const structured = [
            {
                artist: 'A',
                lang: 'en',
                lyrics: [{ startMs: 0, text: 'hi' }],
                name: 'N',
                remote: false,
                source: 'srv',
            },
        ] as unknown as StructuredLyric[];
        const row = toLyricsRow('s3', structured, NOW);
        expect(row.SongId).toBe('s3');
        expect(row.Synced).toBe(true);
        expect(row.Payload).toBe(structured[0]);
        expect(row.Lyrics).toBe(JSON.stringify([{ startMs: 0, text: 'hi' }]));
    });

    it('builds a NEGATIVE marker for null (no lyrics found)', () => {
        expect(toLyricsRow('s4', null, NOW)).toEqual({
            __cachedAt: NOW,
            Lyrics: '',
            Payload: undefined,
            SongId: 's4',
            Synced: false,
        });
    });

    it('builds a NEGATIVE marker for an empty structured array', () => {
        expect(toLyricsRow('s5', [], NOW)).toEqual({
            __cachedAt: NOW,
            Lyrics: '',
            Payload: undefined,
            SongId: 's5',
            Synced: false,
        });
    });
});
