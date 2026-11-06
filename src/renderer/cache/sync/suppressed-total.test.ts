// Album and song sweeps skip the per-page COUNT on pages 2..N
// (EnableTotalRecordCount=false). Jellyfin 10.11 then reports the PAGE length
// as TotalRecordCount instead of 0, which runSweep took as the library total:
// every sync stopped after two pages (~1000 albums / songs). The fetchers must
// only trust page 1's total.

import type { ServerListItem } from '/@/shared/types/domain-types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryCacheDb } from '../db';

import { useCacheStore } from '../store';
import { runAlbumsSweep } from './albums';
import { runSongsSweep } from './songs';
import { setSweepRetryBaseMsForTests } from './sweep';

const LIBRARY_SIZE = 1200;

// Mirrors Jellyfin 10.11: with EnableTotalRecordCount=false the response's
// TotalRecordCount is the number of items in the page, not 0.
const page = ({
    query,
}: {
    query: { _custom?: Record<string, unknown>; limit: number; startIndex: number };
}) => {
    const n = Math.max(0, Math.min(query.limit, LIBRARY_SIZE - query.startIndex));
    const items = Array.from({ length: n }, (_, i) => ({ id: `item-${query.startIndex + i}` }));
    const counted = query._custom?.EnableTotalRecordCount !== false;
    return { items, startIndex: query.startIndex, totalRecordCount: counted ? LIBRARY_SIZE : n };
};

vi.mock('/@/renderer/api/controller', () => ({
    controller: {
        getAlbumList: vi.fn(async (args) => page(args)),
        getSongList: vi.fn(async (args) => page(args)),
    },
}));

const makeDb = () => {
    const written: unknown[] = [];
    const table = {
        bulkPut: vi.fn(async (rows: unknown[]) => {
            written.push(...rows);
        }),
        count: vi.fn(async () => 0),
    };
    const db = {
        albums: table,
        songs: table,
        syncMeta: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
        table: () => table,
        transaction: vi.fn(async (_mode: string, ...rest: unknown[]) => {
            await (rest.pop() as () => Promise<void>)();
        }),
    } as unknown as LibraryCacheDb;
    return { db, written };
};

const server = { id: 'srv', type: 'jellyfin', url: 'http://jf' } as ServerListItem;

beforeEach(() => setSweepRetryBaseMsForTests(0));

afterEach(() => {
    vi.clearAllMocks();
    useCacheStore.setState((s) => ({ ...s, sweep: undefined }) as never);
});

describe('album/song sweeps with a suppressed per-page count', () => {
    it('songs: syncs the whole library, not just the first two pages', async () => {
        const { db, written } = makeDb();
        await runSongsSweep({ db, entity: 'songs', signal: new AbortController().signal }, server);
        expect(written).toHaveLength(LIBRARY_SIZE);
    });

    it('albums: syncs the whole library, not just the first two pages', async () => {
        const { db, written } = makeDb();
        await runAlbumsSweep(
            { db, entity: 'albums', signal: new AbortController().signal },
            server,
        );
        expect(written).toHaveLength(LIBRARY_SIZE);
    });
});
