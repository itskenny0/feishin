// Behavioural tests for runLyricsSweep against a lightweight Dexie shim and an
// injected lyrics fetcher (so no real network / IndexedDB is touched).
//
// Contracts:
//  - Every cached song is considered; a hit writes a positive row, a null
//    result writes a negative marker.
//  - A song that already has a lyrics row is skipped (fetcher NOT called).
//  - Resume starts from the persisted syncMeta checkpoint.
//  - On completion syncMeta('lyrics') is hydrationState 'full' with no checkpoint.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LibraryCacheDb } from '../db';
import type { CachedLyrics } from '../types';

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => true,
    subscribeIsOnline: () => () => {},
}));

// The sweep imports the api controller for its default fetcher; the tests
// inject `fetchLyrics`, so stub the controller to keep its heavy
// react-query/window side-effects out of the test environment.
vi.mock('/@/renderer/api/controller', () => ({
    controller: { getLyrics: vi.fn(), getStructuredLyrics: vi.fn() },
}));

import type { SweepContext } from './sweep';

import { runLyricsSweep } from './lyrics';

const server = { id: 'srv', name: 'Test', type: 'jellyfin' } as never;

const makeDb = (songIds: string[], existingLyrics: Record<string, CachedLyrics> = {}) => {
    const lyrics = new Map<string, CachedLyrics>(Object.entries(existingLyrics));
    const songs = new Map(
        songIds.map((id) => [id, { Id: id, Payload: { artists: [], id, name: id } }]),
    );
    const syncMeta = new Map<string, { nextStartIndex?: number }>();
    const db = {
        lyrics: {
            bulkGet: async (ids: string[]) => ids.map((id) => lyrics.get(id)),
            bulkPut: async (rows: CachedLyrics[]) => {
                for (const r of rows) lyrics.set(r.SongId, r);
            },
            count: async () => lyrics.size,
        },
        songs: {
            bulkGet: async (ids: string[]) => ids.map((id) => songs.get(id)),
            orderBy: () => ({ primaryKeys: async () => [...songIds].sort() }),
        },
        syncMeta: {
            get: async (k: string) => syncMeta.get(k),
            put: async (m: { EntityType: string; nextStartIndex?: number }) => {
                syncMeta.set(m.EntityType, m);
            },
        },
    } as unknown as LibraryCacheDb;
    return { db, lyrics, syncMeta };
};

const ctx = (db: LibraryCacheDb): SweepContext => ({
    db,
    entity: 'lyrics',
    signal: new AbortController().signal,
});

const positive = (text: string) => ({
    artist: 'A',
    lyrics: text,
    name: 'N',
    remote: false,
    source: 'srv',
});

afterEach(() => vi.clearAllMocks());

describe('runLyricsSweep', () => {
    it('writes positive rows for hits and negative markers for misses', async () => {
        const { db, lyrics } = makeDb(['a', 'b', 'c']);
        const fetchLyrics = vi.fn(async (song: { id: string }) =>
            song.id === 'c' ? null : positive(`lyrics-${song.id}`),
        );

        await runLyricsSweep(ctx(db), server, { fetchLyrics, now: () => 100 });

        expect(lyrics.get('a')).toMatchObject({ Lyrics: 'lyrics-a', SongId: 'a', Synced: false });
        expect(lyrics.get('b')).toMatchObject({ Lyrics: 'lyrics-b' });
        // miss → negative marker: empty Lyrics, no Payload
        expect(lyrics.get('c')).toMatchObject({ Lyrics: '', Payload: undefined, SongId: 'c' });
        expect(fetchLyrics).toHaveBeenCalledTimes(3);
    });

    it('skips songs that already have a lyrics row (no fetch)', async () => {
        const { db } = makeDb(['a', 'b'], {
            a: {
                __cachedAt: 1,
                Lyrics: 'cached',
                Payload: positive('cached'),
                SongId: 'a',
                Synced: false,
            },
        });
        const fetchLyrics = vi.fn(async (song: { id: string }) => positive(`x-${song.id}`));

        await runLyricsSweep(ctx(db), server, { fetchLyrics, now: () => 1 });

        const fetchedIds = fetchLyrics.mock.calls.map((c) => (c[0] as { id: string }).id);
        expect(fetchedIds).toEqual(['b']);
    });

    it('resumes from the persisted checkpoint', async () => {
        const { db, syncMeta } = makeDb(['a', 'b', 'c']);
        syncMeta.set('lyrics', { nextStartIndex: 2 } as never);
        const fetchLyrics = vi.fn(async (song: { id: string }) => positive(song.id));

        await runLyricsSweep(ctx(db), server, { fetchLyrics, now: () => 1 });

        const fetchedIds = fetchLyrics.mock.calls.map((c) => (c[0] as { id: string }).id);
        expect(fetchedIds).toEqual(['c']);
    });

    it('marks the entity full with no checkpoint on completion', async () => {
        const { db, syncMeta } = makeDb(['a']);
        await runLyricsSweep(ctx(db), server, {
            fetchLyrics: async () => positive('x'),
            now: () => 1,
        });

        expect(syncMeta.get('lyrics')).toMatchObject({
            hydrationState: 'full',
            nextStartIndex: undefined,
        });
    });
});
