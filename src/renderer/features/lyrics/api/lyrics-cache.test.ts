// Regression coverage for lyrics download + serve through the Dexie cache.
//
// `lyricsQueries.songLyrics` wires the lyrics fetch through `cachedSwr` with a
// `fromCache` read (db.lyrics.get) and an `apply` write (db.lyrics.put of the
// full FullLyricsMetadata Payload). We mock `cachedSwr` to capture those three
// callbacks, then drive them directly against an in-memory Dexie lyrics-table
// shim to assert:
//   - apply() persists the local lyrics Payload keyed by SongId
//   - fromCache() serves a primed result from a previously-cached row
//     (offline / instant-paint path)
//   - remote() is what feeds apply() on a cache miss (download path)

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedLyrics } from '/@/renderer/cache/types';
import type { QueueSong } from '/@/shared/types/domain-types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- captured cachedSwr args ------------------------------------------

interface CachedSwrArgs<T> {
    apply?: (db: LibraryCacheDb, fresh: T) => Promise<void>;
    ctx: unknown;
    fromCache?: (db: LibraryCacheDb) => Promise<T | undefined>;
    queryKey: unknown;
    remote: (ctx: unknown) => Promise<T>;
}

const mocks = vi.hoisted(() => ({
    jfLyrics: { current: 'plain lyrics line' as unknown },
    lastSwr: { current: undefined as CachedSwrArgs<any> | undefined },
    prevQueryData: { current: undefined as unknown },
    serverFeature: { current: 'lyricsSingleStructured' },
    structuredLyrics: { current: undefined as unknown },
}));

vi.mock('/@/renderer/cache', () => ({
    cachedSwr: <T>(args: CachedSwrArgs<T>): Promise<T> => {
        mocks.lastSwr.current = args;
        // Mimic the real runner's cache-first contract closely enough for the
        // test: if the consumer asked for a fromCache read we don't drive it
        // here (the tests invoke the callbacks explicitly), just resolve via
        // remote so the queryFn settles.
        return args.remote(args.ctx);
    },
    readSnapshot: () => undefined,
    snapshotSwr: async <T>(args: { ctx: unknown; remote: (ctx: unknown) => Promise<T> }) =>
        args.remote(args.ctx),
    // Faithful stand-in for the real cache helper (which has its own unit tests
    // in cache/sync/lyrics-row.test.ts). Importing the real one would pull the
    // api controller into this isolated wiring test.
    toLyricsRow: (songId: string, result: unknown, nowMs: number) => {
        const meta = (Array.isArray(result) ? result[0] : result) as
            | null
            | undefined
            | { lyrics?: unknown };
        if (!meta || meta.lyrics == null) {
            return {
                __cachedAt: nowMs,
                Lyrics: '',
                Payload: undefined,
                SongId: songId,
                Synced: false,
            };
        }
        const synced = Array.isArray(meta.lyrics);
        return {
            __cachedAt: nowMs,
            Lyrics: synced ? JSON.stringify(meta.lyrics) : (meta.lyrics as string),
            Payload: meta,
            SongId: songId,
            Synced: synced,
        };
    },
}));

vi.mock('/@/renderer/store', () => ({
    getServerById: () => ({ name: 'Test Server', type: 'jellyfin' }),
    useSettingsStore: {
        getState: () => ({ lyrics: { fetch: false, preferLocalLyrics: false } }),
    },
}));

vi.mock('/@/renderer/lib/react-query', () => ({
    queryClient: { getQueryData: () => mocks.prevQueryData.current },
}));

vi.mock('is-electron', () => ({ default: () => false }));

vi.mock('/@/shared/api/utils', () => ({
    hasFeature: (_server: unknown, feature: string) => feature === mocks.serverFeature.current,
}));

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getLyrics: vi.fn(async () => mocks.jfLyrics.current),
            getStructuredLyrics: vi.fn(async () => mocks.structuredLyrics.current),
        },
    },
}));

vi.mock('/@/renderer/api/query-keys', () => ({
    queryKeys: {
        songs: {
            lyrics: (serverId: string, query: { songId: string }) => [serverId, 'lyrics', query],
            lyricsByRemoteId: () => ['lyricsByRemoteId'],
            lyricsSearch: () => ['lyricsSearch'],
        },
    },
}));

// --- in-memory Dexie lyrics-table shim --------------------------------

class LyricsTableShim {
    readonly rows = new Map<string, CachedLyrics>();

    async get(songId: string): Promise<CachedLyrics | undefined> {
        return this.rows.get(songId);
    }

    async put(row: CachedLyrics): Promise<void> {
        this.rows.set(row.SongId, row);
    }
}

const makeDb = (): { db: LibraryCacheDb; lyrics: LyricsTableShim } => {
    const lyrics = new LyricsTableShim();
    return { db: { lyrics } as unknown as LibraryCacheDb, lyrics };
};

import { lyricsQueries } from '/@/renderer/features/lyrics/api/lyrics-api';

const song = (): QueueSong =>
    ({
        _serverId: 'srv1',
        artists: [{ id: 'a1', name: 'Artist' }],
        id: 'song-1',
        name: 'Song A',
    }) as unknown as QueueSong;

beforeEach(() => {
    mocks.lastSwr.current = undefined;
    mocks.prevQueryData.current = undefined;
    mocks.serverFeature.current = 'lyricsSingleStructured';
    mocks.structuredLyrics.current = undefined;
    mocks.jfLyrics.current = 'plain lyrics line';
});

describe('lyrics Dexie cache wiring', () => {
    it('downloads via remote() and persists the Payload via apply() (cache write)', async () => {
        const options = lyricsQueries.songLyrics(
            { options: {}, query: { songId: 'song-1' }, serverId: 'srv1' },
            song(),
        );

        // Drive the queryFn — our cachedSwr mock captures the callbacks and
        // returns the remote() result (the download path on a cache miss).
        const fresh = await options.queryFn!({ signal: undefined } as never);
        expect(mocks.lastSwr.current).toBeDefined();

        // The freshly downloaded result carries the server lyrics.
        expect((fresh as { local: unknown }).local).toBeTruthy();

        // Now exercise apply() — the cache write the SWR runner performs after
        // a successful download — and assert it persisted the Payload.
        const { db, lyrics } = makeDb();
        await mocks.lastSwr.current!.apply!(db, fresh);

        const row = lyrics.rows.get('song-1');
        expect(row).toBeDefined();
        expect(row?.SongId).toBe('song-1');
        expect(row?.Payload).toBeTruthy();
        expect(row?.Lyrics).toContain('plain lyrics line');
    });

    it('serves a primed result from cache via fromCache() (offline read)', async () => {
        const options = lyricsQueries.songLyrics(
            { options: {}, query: { songId: 'song-1' }, serverId: 'srv1' },
            song(),
        );
        // Invoke the queryFn so our cachedSwr mock captures the callbacks.
        await options.queryFn!({ signal: undefined } as never);

        const { db, lyrics } = makeDb();
        // Seed a previously-downloaded row.
        lyrics.rows.set('song-1', {
            __cachedAt: Date.now(),
            Lyrics: 'cached line',
            Payload: {
                artist: 'Artist',
                lyrics: 'cached line',
                name: 'Song A',
                remote: false,
                source: 'Test Server',
            },
            SongId: 'song-1',
            Synced: false,
        } as CachedLyrics);

        const seeded = await mocks.lastSwr.current!.fromCache!(db);
        expect(seeded).toBeDefined();
        expect((seeded as { local: { lyrics: string } }).local.lyrics).toBe('cached line');
        expect((seeded as { selected: { lyrics: string } }).selected.lyrics).toBe('cached line');
    });

    it('fromCache() returns undefined on a true miss (falls through to remote)', async () => {
        const options = lyricsQueries.songLyrics(
            { options: {}, query: { songId: 'song-1' }, serverId: 'srv1' },
            song(),
        );
        await options.queryFn!({ signal: undefined } as never);

        const { db } = makeDb();
        const seeded = await mocks.lastSwr.current!.fromCache!(db);
        expect(seeded).toBeUndefined();
    });

    it.each([
        ['a search override', { overrideSelection: { id: 'remote-1', source: 'lrclib' } }],
        ['a Clear', { suppressRemoteAuto: true }],
    ])('fromCache() is bypassed while %s is pending', async (_label, prev) => {
        const options = lyricsQueries.songLyrics(
            { options: {}, query: { songId: 'song-1' }, serverId: 'srv1' },
            song(),
        );
        await options.queryFn!({ signal: undefined } as never);

        const { db, lyrics } = makeDb();
        lyrics.rows.set('song-1', {
            __cachedAt: Date.now(),
            Lyrics: 'cached line',
            Payload: { lyrics: 'cached line', remote: true, source: 'lrclib' },
            SongId: 'song-1',
            Synced: false,
        } as CachedLyrics);

        mocks.prevQueryData.current = prev;
        expect(await mocks.lastSwr.current!.fromCache!(db)).toBeUndefined();
    });

    it('defaults to the first synced main structured lyric, not index 0', async () => {
        mocks.serverFeature.current = 'lyricsMultipleStructured';
        mocks.structuredLyrics.current = [
            { lang: 'eng', lyrics: 'plain text', synced: false },
            { kind: 'main', lang: 'eng', lyrics: [{ startMs: 0, text: 'a' }], synced: true },
        ];
        const options = lyricsQueries.songLyrics(
            { options: {}, query: { songId: 'song-1' }, serverId: 'srv1' },
            song(),
        );

        const fresh = (await options.queryFn!({ signal: undefined } as never)) as {
            selectedStructuredIndex: number;
            selectedSynced: boolean;
        };
        expect(fresh.selectedStructuredIndex).toBe(1);
        expect(fresh.selectedSynced).toBe(true);
    });
});
