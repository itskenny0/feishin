// Worker-backed path of the local search (search.ts): the index lives in a
// Web Worker that answers with hit ids, and the renderer maps them back to
// payloads. jsdom has no Worker, so a fake one stands in for
// search-index.worker.ts and speaks its message protocol.

import type { SearchWorkerRequest } from '/@/renderer/cache/search-index.worker';

import { afterAll, describe, expect, it, vi } from 'vitest';

const ROWS = {
    albums: [] as { Id: string; Payload: { id: string; name: string } }[],
    artists: [] as { Id: string; Payload: { id: string; name: string } }[],
    songs: [
        { Id: 's1', Payload: { id: 's1', name: 'Come Together' } },
        { Id: 's2', Payload: { id: 's2', name: 'Something' } },
    ],
};

const table = (rows: { Id: string }[]) => ({
    bulkGet: async (ids: string[]) => ids.map((id) => rows.find((r) => r.Id === id)),
});
const mockDb = {
    albums: table(ROWS.albums),
    artists: table(ROWS.artists),
    name: 'feishin-cache:test:user',
    songs: table(ROWS.songs),
};

vi.mock('/@/renderer/cache/capability', () => ({
    isCacheAvailable: async () => true,
    isCacheAvailableSync: () => true,
}));
vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mockDb,
}));

// Search replies are held until the test releases them, so a burst of
// keystrokes can pile up behind a running scan.
const received: SearchWorkerRequest[] = [];
const held: (() => void)[] = [];
let hits: string[] = [];

class FakeWorker {
    onerror: ((event: { message: string }) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;

    postMessage(msg: SearchWorkerRequest) {
        received.push(msg);
        if (msg.type === 'build') {
            queueMicrotask(() =>
                this.onmessage?.({
                    data: { id: msg.id, ok: true, rows: ROWS[msg.entity].length },
                }),
            );
        } else if (msg.type === 'search') {
            const ids = [...hits];
            held.push(() => this.onmessage?.({ data: { id: msg.id, ids, ok: true } }));
        }
    }

    terminate() {
        held.length = 0;
    }
}
vi.stubGlobal('Worker', FakeWorker);

const { searchSongsLocal } = await import('/@/renderer/cache/search');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const releaseAll = async () => {
    while (held.length) {
        held.shift()!();
        await flush();
    }
};

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('worker-backed local search', () => {
    it('builds in the worker and maps hit ids to payloads in hit order, dropping deleted rows', async () => {
        hits = ['s2', 'gone', 's1'];
        const pending = searchSongsLocal('so');
        await flush();
        await flush();
        expect(received.some((m) => m.type === 'build' && m.dbName === mockDb.name)).toBe(true);
        await releaseAll();

        expect(await pending).toEqual([ROWS.songs[1].Payload, ROWS.songs[0].Payload]);
    });

    it('keeps at most one search queued behind the running one', async () => {
        hits = ['s1'];
        received.length = 0;
        const first = searchSongsLocal('c');
        await flush();
        const second = searchSongsLocal('co');
        const third = searchSongsLocal('com');
        await flush();

        // Only the running scan reached the worker; 'co' was replaced by 'com'.
        expect(received.map((m) => (m.type === 'search' ? m.query : m.type))).toEqual(['c']);
        await releaseAll();

        expect(await second).toEqual([]);
        expect(await first).toEqual([ROWS.songs[0].Payload]);
        expect(await third).toEqual([ROWS.songs[0].Payload]);
        expect(received.map((m) => (m.type === 'search' ? m.query : m.type))).toEqual(['c', 'com']);
    });
});
