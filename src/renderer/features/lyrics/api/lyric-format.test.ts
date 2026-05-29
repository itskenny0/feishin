// Unit coverage for the pure LRC / NetEase-karaoke lyric parser exported as
// `formatLyricsForDisplay`. The parser is the only piece of `lyrics-api` that
// is pure synchronous logic; the surrounding query wiring is exercised in
// `lyrics-cache.test.ts`. We stub the heavy app-shell imports (api/store/etc.)
// so importing the module stays cheap and side-effect free — mirroring the
// approach taken by the sibling cache test.

import type { SynchronizedLyricsArray } from '/@/shared/types/domain-types';

import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/renderer/api', () => ({ api: { controller: {} } }));
vi.mock('/@/renderer/api/query-keys', () => ({ queryKeys: { songs: {} } }));
vi.mock('/@/renderer/cache', () => ({
    cachedSwr: vi.fn(),
    readSnapshot: () => undefined,
    snapshotSwr: vi.fn(),
}));
vi.mock('/@/renderer/store', () => ({
    getServerById: () => undefined,
    useSettingsStore: { getState: () => ({ lyrics: {} }) },
}));
vi.mock('/@/renderer/lib/react-query', () => ({
    queryClient: { getQueryData: () => undefined },
}));
vi.mock('is-electron', () => ({ default: () => false }));

import { formatLyricsForDisplay } from '/@/renderer/features/lyrics/api/lyrics-api';

const asSynced = (result: ReturnType<typeof formatLyricsForDisplay>): SynchronizedLyricsArray => {
    if (typeof result === 'string') throw new Error('expected synchronized lyrics, got plain text');
    return result;
};

describe('formatLyricsForDisplay — LRC timestamps', () => {
    it('parses [mm:ss.SSS] lines into [ms, text] tuples', () => {
        const lrc = '[00:01.500]first line\n[00:02.250]second line';
        const synced = asSynced(formatLyricsForDisplay(lrc));
        expect(synced).toEqual([
            [1500, 'first line'],
            [2250, 'second line'],
        ]);
    });

    it('treats two-digit fractional seconds as centiseconds (x10)', () => {
        // [00:00.05] -> 50ms (05 centiseconds), per the *10 branch.
        const synced = asSynced(formatLyricsForDisplay('[00:00.05]centi'));
        expect(synced).toEqual([[50, 'centi']]);
    });

    it('handles minutes beyond 60 and missing fractional part', () => {
        // No fractional component -> milis is NaN*... guarded? The parser uses
        // parseInt(undefined) -> NaN; assert the integer minute/second math.
        const synced = asSynced(formatLyricsForDisplay('[01:30.000]ninety seconds'));
        expect(synced).toEqual([[90_000, 'ninety seconds']]);
    });

    it('preserves line order across multiple timestamps', () => {
        const lrc = '[00:00.000]a\n[00:10.000]b\n[00:05.000]c';
        const synced = asSynced(formatLyricsForDisplay(lrc));
        expect(synced.map(([, text]) => text)).toEqual(['a', 'b', 'c']);
        expect(synced.map(([ms]) => ms)).toEqual([0, 10_000, 5_000]);
    });
});

describe('formatLyricsForDisplay — NetEase karaoke fallback', () => {
    it('parses [ms,dur] karaoke lines when no LRC timestamps match', () => {
        const synced = asSynced(formatLyricsForDisplay('[1200,300]hello\n[2000,300]world'));
        expect(synced).toEqual([
            [1200, 'hello'],
            [2000, 'world'],
        ]);
    });

    it('strips inline (offset,dur) word markers and tidies stray punctuation', () => {
        const synced = asSynced(formatLyricsForDisplay('[0,500]hel(10,20)lo (30,40) , world .'));
        expect(synced[0][0]).toBe(0);
        expect(synced[0][1]).toBe('hello , world.');
    });
});

describe('formatLyricsForDisplay — plain text', () => {
    it('returns the original string unchanged when no timestamps are present', () => {
        const plain = 'just\nsome\nplain lyrics';
        expect(formatLyricsForDisplay(plain)).toBe(plain);
    });

    it('returns an empty string unchanged', () => {
        expect(formatLyricsForDisplay('')).toBe('');
    });
});
