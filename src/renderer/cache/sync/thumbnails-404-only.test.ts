// Regression: ONLY an authoritative HTTP 404 may write a negative (MissAt)
// marker in the thumbnail sweep. Transient failures (timeout, connection
// reset, 5xx/429, decode error, offline) must NEVER write a negative marker
// and must NEVER be reported as a permanent "missing" outcome — otherwise a
// network drop mid-sweep strands items as "no artwork" until a manual clear.
//
// Symptom (slow phone-hosted Jellyfin over flaky wifi): the link drops
// mid-sweep and items end up marked unavailable. The fix distinguishes:
//   fetched   → blob written
//   missing   → authoritative 404, MissAt marker written, safe to skip
//   transient → nothing authoritative written, retried later
//
// images.ts (the DOWNLOAD path's resolver) is covered elsewhere; this file
// pins the sweep's two unit functions directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string =>
        Array.isArray(key) ? JSON.stringify(key) : String(key);
    const thumbnailsTable = {
        get: vi.fn(async (key: unknown) => store.get(keyOf(key))),
        put: vi.fn(async (row: any) => {
            store.set(keyOf([row.ItemId, row.Variant]), row);
        }),
        update: vi.fn(async () => undefined),
        where: vi.fn(() => ({
            equals: () => ({ toArray: async () => [] }),
        })),
    };
    const db = { thumbnails: thumbnailsTable };
    // Resolver result the DOWNLOAD path's fetchDownloadUnit will receive. The
    // test swaps this per-case to simulate fetched / 404 / transient.
    const resolverResult = {
        value: { bytes: 0 as number, noArtwork: undefined as boolean | undefined },
    };
    return { db, resolverResult, store, thumbnailsTable };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/images', () => ({
    MAX_CACHE_SIZE: 1024,
    // The sync barrel's import graph also pulls these; inert stubs suffice.
    resolveThumbnail: vi.fn(async (_i: string, _v: string, r: string | { url?: string }) =>
        typeof r === 'string' ? r : (r?.url ?? ''),
    ),
    // Whatever the test put in resolverResult — lets us model the download
    // resolver returning fetched / authoritative-404 / transient.
    resolveThumbnailWithBytes: vi.fn(async () => mocks.resolverResult.value),
    rewriteUrlToVariantSize: (url: string) => url,
}));

vi.mock('/@/renderer/cache/variant-downscale-pool', () => ({
    downscaleVariantsPooled: vi.fn(
        async (_src: Blob, variants: { px: number; variant: string }[]) =>
            new Map(
                variants.map((v) => [
                    v.variant,
                    { blob: new Blob([new Uint8Array(64)]), format: 'webp' as const },
                ]),
            ),
    ),
}));

import { __thumbnailsSweepInternals } from '/@/renderer/cache/sync/thumbnails';

const CFG = {
    format: 'webp',
    mode: 'downscale',
    quality: 82,
    variants: {
        fullScreen: { enabled: false, px: 0 },
        header: { enabled: true, px: 300 },
        itemCard: { enabled: true, px: 300 },
        sidebar: { enabled: false, px: 400 },
        table: { enabled: true, px: 80 },
    },
} as any;

const TEMPLATE = {
    credentials: undefined,
    headers: undefined,
    urlAfter: '/Images/Primary?width=1024',
    urlBefore: 'https://server.example/Items/',
};

const downscalePending = {
    downscaleVariants: [
        { px: 80, variant: 'table' },
        { px: 300, variant: 'itemCard' },
    ],
    itemId: 'abc',
    itemType: 'album',
    kind: 'album',
    px: 300,
} as any;

const downloadPending = {
    itemId: 'dl1',
    itemType: 'album',
    kind: 'album',
    px: 80,
    variant: 'table',
} as any;

const fetchReturning = (status: number, ok: boolean, throws?: Error): typeof fetch =>
    vi.fn(async () => {
        if (throws) throw throws;
        return {
            blob: async () => new Blob([new Uint8Array(2048)]),
            headers: { get: () => 'image/jpeg' },
            ok,
            status,
        } as unknown as Response;
    }) as unknown as typeof fetch;

const missMarkers = (): any[] => [...mocks.store.values()].filter((r) => r.MissAt);

beforeEach(() => {
    mocks.store.clear();
    mocks.resolverResult.value = { bytes: 0, noArtwork: undefined };
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('downscale sweep: 404-only negative markers', () => {
    it('writes a MissAt marker for every variant on an authoritative 404', async () => {
        globalThis.fetch = fetchReturning(404, false);
        const result = await __thumbnailsSweepInternals.fetchDownscaleUnit(
            downscalePending,
            TEMPLATE,
            CFG,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('missing');
        const markers = missMarkers();
        expect(markers.map((m) => m.Variant).sort()).toEqual(['itemCard', 'table']);
        expect(markers.every((m) => m.Blob === undefined)).toBe(true);
    });

    it('does NOT write a marker on a 5xx (server reachable, artwork may exist)', async () => {
        globalThis.fetch = fetchReturning(503, false);
        const result = await __thumbnailsSweepInternals.fetchDownscaleUnit(
            downscalePending,
            TEMPLATE,
            CFG,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('transient');
        expect(missMarkers()).toHaveLength(0);
    });

    it('does NOT write a marker on a network throw (timeout / reset)', async () => {
        globalThis.fetch = fetchReturning(0, false, new TypeError('Failed to fetch'));
        const result = await __thumbnailsSweepInternals.fetchDownscaleUnit(
            downscalePending,
            TEMPLATE,
            CFG,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('transient');
        expect(missMarkers()).toHaveLength(0);
    });

    it('writes blob rows (no markers) on success', async () => {
        globalThis.fetch = fetchReturning(200, true);
        const result = await __thumbnailsSweepInternals.fetchDownscaleUnit(
            downscalePending,
            TEMPLATE,
            CFG,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('fetched');
        expect(result.bytes).toBeGreaterThan(0);
        expect(missMarkers()).toHaveLength(0);
        const blobRows = [...mocks.store.values()].filter((r) => r.Blob);
        expect(blobRows.map((r) => r.Variant).sort()).toEqual(['itemCard', 'table']);
    });
});

describe('download sweep: outcome reflects resolver authority', () => {
    it('reports fetched when the resolver returned bytes', async () => {
        mocks.resolverResult.value = { bytes: 4096, noArtwork: undefined };
        const result = await __thumbnailsSweepInternals.fetchDownloadUnit(
            downloadPending,
            TEMPLATE,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('fetched');
    });

    it('reports missing ONLY when the resolver flagged an authoritative 404', async () => {
        mocks.resolverResult.value = { bytes: 0, noArtwork: true };
        const result = await __thumbnailsSweepInternals.fetchDownloadUnit(
            downloadPending,
            TEMPLATE,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('missing');
    });

    it('reports transient when the resolver returned zero bytes WITHOUT a 404', async () => {
        // This is the flaky-network case: the resolver timed out / hit an
        // unreachable server and wrote NO negative marker. Must be retried.
        mocks.resolverResult.value = { bytes: 0, noArtwork: undefined };
        const result = await __thumbnailsSweepInternals.fetchDownloadUnit(
            downloadPending,
            TEMPLATE,
            new AbortController().signal,
        );
        expect(result.outcome).toBe('transient');
    });
});
