// The placeholderData function for react-query must be synchronous. Dexie
// reads are async. We bridge that with an in-memory map populated by every
// Dexie read we do in this session — so once a queryKey has been read
// from disk, the next mount finds the snapshot synchronously.
//
// The map is keyed by JSON.stringify(queryKey) because react-query's own
// hash strategy is stable across renders.
//
// The map is also lazily persisted to localStorage so that a page reload /
// app restart doesn't lose the warm path. Without persistence, every
// surface a user navigates to AFTER a restart shows a loading state on
// first mount because react-query's `placeholderData` resolver runs sync
// (it can't await Dexie). With persistence, the map is restored synchronously
// during module load so the very first mount after a cold start finds a
// primed snapshot and paints from cache instantly.

import type { QueryKey } from '@tanstack/react-query';

// Tunables for the localStorage mirror. Each entry stores a single query
// response — typically a few-KB to a few-hundred-KB JSON object. We cap
// both the entry count and the total serialized byte count so the mirror
// never exceeds a few MB and we evict the least-recently-written entries
// first.
const STORAGE_KEY = 'feishin:cache:snapshots:v1';
// Kept intentionally conservative: localStorage quota is shared with auth
// state and settings. Chromium grants 5MB per origin by default; we target
// ≤3MB so snapshots never crowd out other keys even under heavy use.
// 300 entries of ~10KB average = 3MB — covers the most-recently-visited
// list pages and detail surfaces without hoarding stale history.
const MAX_ENTRIES = 300;
const MAX_BYTES = 3 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 500;

// LRU-ish: we track insertion order via Map iteration. Map preserves
// insertion order and `.set()` on an existing key does NOT move it, so we
// explicitly delete-then-set on writes to bump entries to the tail.
const snapshots = new Map<string, unknown>();

const hash = (key: QueryKey): string => JSON.stringify(key);

const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

let persistTimer: ReturnType<typeof setTimeout> | undefined;

const schedulePersist = (): void => {
    if (!isBrowser) return;
    if (persistTimer !== undefined) return;
    persistTimer = setTimeout(() => {
        persistTimer = undefined;
        persistNow();
    }, PERSIST_DEBOUNCE_MS);
};

const persistNow = (): void => {
    if (!isBrowser) return;
    try {
        // Walk newest-to-oldest, dropping entries once we hit either cap.
        // Store raw objects (not pre-serialized strings) so the final
        // JSON.stringify(kept) encodes each value once; double-encoding
        // would escape quotes/backslashes and make the stored blob 1.5-2×
        // larger than the byte budget suggests.
        const reversed = Array.from(snapshots.entries()).reverse();
        const kept: [string, unknown][] = [];
        let bytes = 0;
        for (const [k, v] of reversed) {
            if (kept.length >= MAX_ENTRIES) break;
            let serialized: string;
            try {
                serialized = JSON.stringify(v);
            } catch {
                // Non-serializable payload (e.g. holds a Blob). Skip it —
                // it can still live in memory for the current session.
                continue;
            }
            // +10 accounts for key quoting, array brackets, and comma overhead
            // in the outer JSON.stringify — keep the estimate tight so we never
            // cut too many entries when objects are small.
            const entryBytes = k.length + serialized.length + 10;
            if (bytes + entryBytes > MAX_BYTES) continue;
            bytes += entryBytes;
            kept.push([k, v]);
        }
        // Reverse again so we end up writing oldest-first and the most-
        // recent entries are the last ones in the stored object.
        kept.reverse();
        const payload = JSON.stringify(kept);
        localStorage.setItem(STORAGE_KEY, payload);
    } catch (err) {
        // Quota exceeded or storage disabled (private mode). Drop the
        // mirror entirely so the next persist tries fresh.
        console.warn('[cache] snapshot persist failed', err);
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // ignore
        }
    }
};

const restoreFromStorage = (): void => {
    if (!isBrowser) return;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as [string, unknown][];
        if (!Array.isArray(parsed)) return;
        for (const entry of parsed) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [k, v] = entry;
            if (typeof k !== 'string') continue;
            try {
                // New format stores the value as a parsed object directly.
                // Old format stored a JSON string — parse it for backward compat.
                snapshots.set(k, typeof v === 'string' ? JSON.parse(v) : v);
            } catch {
                // Skip an individual unparseable entry but keep the rest.
            }
        }
        console.info('[cache] snapshot restored from localStorage', {
            entries: snapshots.size,
        });
    } catch (err) {
        console.warn('[cache] snapshot restore failed', err);
    }
};

// Restore at module load — synchronous so `placeholderData` resolvers in
// the first render after a reload already see the warm map.
restoreFromStorage();

export const clearAllSnapshots = (): void => {
    snapshots.clear();
    schedulePersist();
};

export const dropSnapshot = (key: QueryKey): void => {
    if (snapshots.delete(hash(key))) schedulePersist();
};

/**
 * Drop everything keyed under a specific serverId. Used on server switch.
 *
 * Earlier versions of this function assumed the serverId was always the
 * FIRST element of every queryKey (the convention in `query-keys.ts`).
 * That assumption holds for the entity factories but is violated by the
 * snapshot keys used by feature-card data hooks, library-stats,
 * server-info, new-since-last-visit, and featured-genres, where the
 * label string lives at index [0] and the serverId at [1] or [2].
 *
 * To catch all of them we scan the stringified queryKey for the
 * JSON-quoted form of the serverId. The quotes act as a word boundary
 * — a key whose entries are `"srv-abc"` matches the needle `"srv-abc"`
 * but a key with `"srv-abc-detail"` does not, because the closing
 * quote of the needle isn't present at that position.
 */
export const dropSnapshotsForServer = (serverId: string): void => {
    if (!serverId) return;
    const needle = JSON.stringify(serverId);
    let dropped = 0;
    for (const k of snapshots.keys()) {
        if (k.includes(needle)) {
            snapshots.delete(k);
            dropped += 1;
        }
    }
    if (dropped > 0) schedulePersist();
};

export const readSnapshot = <T>(key: QueryKey): T | undefined =>
    snapshots.get(hash(key)) as T | undefined;

export const writeSnapshot = <T>(key: QueryKey, value: T): void => {
    const h = hash(key);
    // Bump LRU order by re-inserting.
    if (snapshots.has(h)) snapshots.delete(h);
    snapshots.set(h, value);
    // Evict oldest entries once we exceed the count cap. The byte cap is
    // enforced lazily at persist time.
    while (snapshots.size > MAX_ENTRIES) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        snapshots.delete(oldest);
    }
    schedulePersist();
};
