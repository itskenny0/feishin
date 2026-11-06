// Web Worker that owns the local search indexes (see search.ts).
//
// On a 29k-track library the main-thread index cost was a ~12 s chunked read
// that deserialized every song payload, a ~0.9 s Fuse build, and then 0.3-1.3 s
// of main-thread Fuse work on EVERY search keystroke (4x CPU throttle, a
// phone approximation). Here the worker opens the same IndexedDB itself,
// projects rows to slim entries, builds and queries Fuse, and only hit ids
// cross back to the renderer.
import type Fuse from 'fuse.js';

import Dexie from 'dexie';

import {
    type ChunkTable,
    createSearchFuse,
    readSearchEntries,
    type SearchEntity,
    type SearchEntry,
} from '/@/renderer/cache/search-index';

export type SearchWorkerRequest =
    | { dbName: string; entity: SearchEntity; id: number; type: 'build' }
    | { entity: SearchEntity; id: number; limit: number; query: string; type: 'search' }
    | { type: 'reset' };

export type SearchWorkerResponse =
    | { error: string; id: number; ok: false }
    | { id: number; ids: string[]; ok: true }
    | { id: number; ok: true; rows: null | number };

const indexes = new Map<SearchEntity, Fuse<SearchEntry>>();
// Bumped by every reset so a build that was reading when the cache DB
// switched (server change, wipe) is dropped instead of installed.
let epoch = 0;

const reply = (message: SearchWorkerResponse) => {
    (self as unknown as Worker).postMessage(message);
};

const build = async (dbName: string, entity: SearchEntity, id: number) => {
    const started = epoch;
    // Dynamic mode: no declared schema, Dexie opens the existing DB as-is. The
    // connection lives only for the read so it never blocks a schema upgrade
    // or a cache wipe on the main thread.
    const db = new Dexie(dbName);
    try {
        await db.open();
        const entries = await readSearchEntries(
            db.table(entity) as unknown as ChunkTable,
            entity,
            () => epoch === started,
            false,
        );
        if (entries && epoch === started) indexes.set(entity, createSearchFuse(entity, entries));
        reply({ id, ok: true, rows: entries && epoch === started ? entries.length : null });
    } catch (err) {
        reply({ error: (err as Error)?.message ?? String(err), id, ok: false });
    } finally {
        db.close();
    }
};

self.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
    const msg = event.data;
    if (msg.type === 'reset') {
        epoch += 1;
        indexes.clear();
        return;
    }
    if (msg.type === 'build') {
        void build(msg.dbName, msg.entity, msg.id);
        return;
    }
    const index = indexes.get(msg.entity);
    const ids = index
        ? index.search(msg.query, { limit: msg.limit }).map((result) => result.item.id)
        : [];
    reply({ id: msg.id, ids, ok: true });
};
