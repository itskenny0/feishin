// The thumbnail sweep pre-caches the own cover of songs whose art is distinct
// from their album cover, under the same key every song cover surface uses
// (`songCoverId`). Songs that share their album's cover add no work. Runs
// against a real Dexie DB (fake-indexeddb) so the sparse `OwnCoverId` index
// written by `toCachedSongRow` is what the sweep actually reads.

import 'fake-indexeddb/auto';
import type { Song } from '/@/shared/types/domain-types';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

const LIVE_VARIANTS = vi.hoisted(() => ({
    format: 'webp',
    mode: 'download',
    quality: 82,
    variants: {
        fullScreen: { enabled: false, px: 0 },
        header: { enabled: false, px: 300 },
        itemCard: { enabled: false, px: 300 },
        sidebar: { enabled: false, px: 400 },
        table: { enabled: true, px: 80 },
    },
}));

vi.mock('/@/renderer/cache/db', async (importOriginal) => {
    const actual = await importOriginal<typeof import('/@/renderer/cache/db')>();
    return { ...actual, getActiveCacheDb: () => holder.db };
});

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => true,
    subscribeIsOnline: () => () => undefined,
}));

vi.mock('/@/renderer/cache/eviction', () => ({
    evict: vi.fn(async () => undefined),
    MAX_CACHE_SIZE: 1024,
}));

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getImageRequest: () => ({
                credentials: undefined,
                headers: undefined,
                url: 'https://server.example/Items/__FEISHIN_ID_PLACEHOLDER__/Images/Primary?width=1024',
            }),
        },
    },
}));

vi.mock('/@/renderer/cache/images', () => ({
    MAX_CACHE_SIZE: 1024,
    persistThumbnailFields: vi.fn(async () => ({})),
    resolveThumbnailWithBytes: vi.fn(async () => ({ bytes: 2048, noArtwork: undefined, url: 'x' })),
    rewriteUrlToVariantSize: (url: string) => url,
}));

vi.mock('/@/renderer/store', () => ({
    DEFAULT_IMAGE_VARIANTS: LIVE_VARIANTS,
    useSettingsStore: {
        getState: () => ({ localCache: { imageVariants: LIVE_VARIANTS, thumbnailConcurrency: 2 } }),
    },
}));

import { LibraryCacheDb } from '/@/renderer/cache/db';
import { resolveThumbnailWithBytes } from '/@/renderer/cache/images';
import { toCachedSongRow } from '/@/renderer/cache/row-mappers';
import { collectPending, runThumbnailsSweep } from '/@/renderer/cache/sync/thumbnails';
import { songCoverId } from '/@/shared/utils/song-cover-id';

const resolverMock = vi.mocked(resolveThumbnailWithBytes);
const DB_NAME = 'feishin-cache:song-cover-sweep:user';

const song = (overrides: Partial<Song>): Song =>
    ({
        albumArtists: [],
        albumId: 'album-1',
        discNumber: 1,
        id: 'song',
        imageId: 'album-1',
        trackNumber: 1,
        updatedAt: '',
        ...overrides,
    }) as Song;

const distinct = song({ hasOwnCover: true, id: 'song-distinct', imageId: 'song-distinct' });
const shared = song({ id: 'song-shared' });

let db: LibraryCacheDb;

beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    db = new LibraryCacheDb(DB_NAME);
    await db.open();
    holder.db = db;
    await db.albums.put({
        __cachedAt: 1,
        AlbumArtistId: '',
        DateLastSaved: '',
        GenreIds: [],
        Id: 'album-1',
        Payload: {} as never,
        ProductionYear: undefined,
        SortName: 'a',
    });
    await db.songs.bulkPut([toCachedSongRow(distinct), toCachedSongRow(shared)]);
});

afterEach(async () => {
    db.close();
    holder.db = undefined;
    await Dexie.delete(DB_NAME);
    vi.restoreAllMocks();
    resolverMock.mockClear();
});

describe('thumbnail sweep: distinct song covers', () => {
    it('enqueues only songs with distinct art, under the songCoverId key', async () => {
        const pending = await collectPending(LIVE_VARIANTS as never);
        const songUnits = pending.filter((p) => p.kind === 'song');

        expect(songUnits.map((p) => p.itemId)).toEqual([songCoverId(distinct)]);
        expect(songUnits[0].itemId).toBe('song-distinct');
        expect(pending.some((p) => p.itemId === 'song-shared')).toBe(false);
    });

    it('caches the distinct song cover next to its album cover', async () => {
        await runThumbnailsSweep({ signal: new AbortController().signal }, {
            id: 'srv1',
            url: 'https://server.example',
        } as never);

        const ids = resolverMock.mock.calls.map((c) => c[0]).sort();
        expect(ids).toEqual(['album-1', 'song-distinct']);
        const songCall = resolverMock.mock.calls.find((c) => c[0] === 'song-distinct');
        expect(songCall?.[1]).toBe('table');
        expect((songCall?.[2] as { url: string }).url).toContain(
            '/Items/song-distinct/Images/Primary',
        );
    });
});
