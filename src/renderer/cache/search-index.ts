// Shared core of the local search index, used both by the search worker
// (search-index.worker.ts) and by the main-thread fallback in search.ts.
//
// The index holds a SLIM entry per row - the row id plus the two strings Fuse
// matches on - never the full Payload. A 29k-song library kept ~50 MB of
// payloads alive on the main heap just so a hit could return its object;
// search.ts now maps the handful of hit ids back to payloads with one
// `bulkGet`.

import Fuse from 'fuse.js';

// Minimal chainable view of a Dexie table / collection, so the same reader
// runs against a dynamic-mode Dexie in the worker and the typed main-thread
// handle.
export interface ChunkSource {
    offset: (offset: number) => { limit: (limit: number) => { toArray: () => Promise<unknown[]> } };
}

export interface ChunkTable extends ChunkSource {
    where: (index: string) => { equals: (value: string) => ChunkSource };
}

export type SearchEntity = 'albums' | 'artists' | 'songs';

export interface SearchEntry {
    artist: string;
    id: string;
    name: string;
}

interface IndexedRow {
    Id: string;
    Payload?: { albumArtists?: { name?: string }[]; name?: string };
}

const KEYS = {
    albums: [
        { name: 'name', weight: 0.7 },
        { name: 'artist', weight: 0.3 },
    ],
    // Global search lists album artists only; the 10k+ song-artist rows
    // (Kind 'Artist') stay out of the index.
    artists: [{ name: 'name', weight: 1 }],
    songs: [
        { name: 'name', weight: 0.6 },
        { name: 'artist', weight: 0.4 },
    ],
} satisfies Record<SearchEntity, { name: keyof SearchEntry; weight: number }[]>;

// Threshold 0.3 is intentionally tight: global search should feel precise,
// not fuzzy-permissive. Only the two short strings per entry are walked.
export const createSearchFuse = (entity: SearchEntity, entries: SearchEntry[]): Fuse<SearchEntry> =>
    new Fuse(entries, {
        ignoreLocation: true,
        keys: KEYS[entity],
        threshold: 0.3,
        useExtendedSearch: false,
    });

const toEntry = (row: IndexedRow): SearchEntry => ({
    artist: row.Payload?.albumArtists?.[0]?.name ?? '',
    id: row.Id,
    name: row.Payload?.name ?? '',
});

const CHUNK = 1000;

/**
 * Read every indexable row of `entity` in 1000-row chunks and project each to
 * a slim entry, so at most one chunk of full payloads is alive at a time.
 * `yieldBetweenChunks` lets a main-thread caller keep input and paint
 * responsive between chunk deserializations. Returns null as soon as
 * `isCurrent()` turns false (the DB switched or the index was reset), so a
 * stale build is discarded instead of installed.
 */
export const readSearchEntries = async (
    table: ChunkTable,
    entity: SearchEntity,
    isCurrent: () => boolean,
    yieldBetweenChunks: boolean,
): Promise<null | SearchEntry[]> => {
    const source: ChunkSource =
        entity === 'artists' ? table.where('Kind').equals('AlbumArtist') : table;
    const entries: SearchEntry[] = [];
    for (let offset = 0; ; offset += CHUNK) {
        const batch = (await source.offset(offset).limit(CHUNK).toArray()) as IndexedRow[];
        if (!isCurrent()) return null;
        for (let i = 0; i < batch.length; i += 1) entries.push(toEntry(batch[i]));
        if (batch.length < CHUNK) return entries;
        if (yieldBetweenChunks) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });
        }
    }
};
