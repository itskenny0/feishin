// Thumbnail cache stats. Counts every resolver outcome (blob hit, miss-
// marker hit, fresh fetch, miss-write, fetch failure) plus cumulative
// bytes fetched, and persists across sessions via localStorage so the
// settings dashboard can render a historical view. Cheap module-level
// counters flushed to disk on a 5s interval — high-frequency sweep
// activity doesn't pay a per-event localStorage write.

const STORAGE_KEY = 'feishin:cache:thumbnail-stats:v1';
const FLUSH_INTERVAL_MS = 5_000;

export interface CacheStats {
    blobHits: number;
    bytesFetched: number;
    failed: number;
    fetched: number;
    firstSeenAt: number;
    lastUpdatedAt: number;
    missMarkerHits: number;
    missWrites: number;
}

export type StatKind = 'blobHit' | 'failed' | 'fetched' | 'missMarkerHit' | 'missWrite';

const empty = (): CacheStats => ({
    blobHits: 0,
    bytesFetched: 0,
    failed: 0,
    fetched: 0,
    firstSeenAt: Date.now(),
    lastUpdatedAt: Date.now(),
    missMarkerHits: 0,
    missWrites: 0,
});

let inMemory: CacheStats = empty();
let loaded = false;
let dirty = false;
let flushTimer: ReturnType<typeof setInterval> | undefined;
const subscribers = new Set<(s: CacheStats) => void>();

const load = (): void => {
    if (loaded) return;
    loaded = true;
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<CacheStats>;
        inMemory = {
            blobHits: parsed.blobHits ?? 0,
            bytesFetched: parsed.bytesFetched ?? 0,
            failed: parsed.failed ?? 0,
            fetched: parsed.fetched ?? 0,
            firstSeenAt: parsed.firstSeenAt ?? Date.now(),
            lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
            missMarkerHits: parsed.missMarkerHits ?? 0,
            missWrites: parsed.missWrites ?? 0,
        };
    } catch (err) {
        console.warn('[cache] stats: load failed', err);
    }
};

const flush = (): void => {
    if (!dirty) return;
    dirty = false;
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(inMemory));
    } catch (err) {
        console.warn('[cache] stats: flush failed', err);
    }
};

const ensureFlushTimer = (): void => {
    if (flushTimer) return;
    if (typeof setInterval === 'undefined') return;
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
};

const notify = (): void => {
    for (const fn of subscribers) {
        try {
            fn(inMemory);
        } catch (err) {
            console.warn('[cache] stats: subscriber threw', err);
        }
    }
};

export const recordStat = (kind: StatKind, bytes = 0): void => {
    load();
    ensureFlushTimer();
    switch (kind) {
        case 'blobHit':
            inMemory.blobHits += 1;
            break;
        case 'failed':
            inMemory.failed += 1;
            break;
        case 'fetched':
            inMemory.fetched += 1;
            inMemory.bytesFetched += bytes;
            break;
        case 'missMarkerHit':
            inMemory.missMarkerHits += 1;
            break;
        case 'missWrite':
            inMemory.missWrites += 1;
            break;
    }
    inMemory.lastUpdatedAt = Date.now();
    dirty = true;
    notify();
};

export const getStats = (): CacheStats => {
    load();
    return inMemory;
};

export const resetStats = (): void => {
    inMemory = empty();
    dirty = true;
    flush();
    notify();
};

export const subscribeStats = (fn: (s: CacheStats) => void): (() => void) => {
    subscribers.add(fn);
    return () => {
        subscribers.delete(fn);
    };
};
