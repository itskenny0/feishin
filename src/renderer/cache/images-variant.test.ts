// Unit tests for the variant-keyed thumbnail resolver (schema v11+).
//
// `resolveThumbnail(itemId, variant, request)` keys every Dexie read/write on
// the compound `[itemId, variant]` so each surface bucket (`table`/`itemCard`/
// `header`/...) holds its own pre-sized cover. In-flight dedup is per-variant
// (`${itemId}::${variant}`), so two cards wanting the SAME variant share one
// upstream fetch while a different variant of the same item fetches
// independently. The 404 negative-cache marker is likewise per-variant.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks ------------------------------------------------------------
const mocks = vi.hoisted(() => {
    // A tiny in-memory stand-in for the Dexie `thumbnails` table keyed by the
    // compound `[ItemId, Variant]` (serialised to a string for the Map).
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string => {
        if (Array.isArray(key)) return JSON.stringify(key);
        return String(key);
    };
    const thumbnailsTable = {
        get: vi.fn(async (key: unknown) => store.get(keyOf(key))),
        put: vi.fn(async (row: any) => {
            store.set(keyOf([row.ItemId, row.Variant]), row);
        }),
        update: vi.fn(async (key: unknown, changes: any) => {
            const k = keyOf(key);
            const existing = store.get(k);
            if (existing) store.set(k, { ...existing, ...changes });
        }),
        // Minimal Dexie `where('ItemId').equals(id).toArray()` chain so the
        // resolver can enumerate an item's cached variants for nearest-larger
        // fallback. Only the single index the resolver uses is supported.
        where: vi.fn((index: string) => ({
            equals: (value: unknown) => ({
                toArray: async () =>
                    [...store.values()].filter((row: any) => (row as any)[index] === value),
            }),
        })),
    };
    const db = { thumbnails: thumbnailsTable };
    return { db, store, thumbnailsTable };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
    NO_ARTWORK_URL: 'feishin://no-artwork',
    registerThumbnailUrlCache: vi.fn(),
}));

// The resolver reads `localCache.imageVariants` to size the nearest-larger
// fallback. Provide the canonical defaults so `table`(80) wants something
// >= 80px and `itemCard`(300) qualifies.
vi.mock('/@/renderer/store/settings.store', () => ({
    DEFAULT_IMAGE_VARIANTS: {
        format: 'webp',
        mode: 'downscale',
        quality: 82,
        variants: {
            fullScreen: { enabled: true, px: 0 },
            header: { enabled: true, px: 300 },
            itemCard: { enabled: true, px: 300 },
            sidebar: { enabled: false, px: 400 },
            table: { enabled: true, px: 80 },
        },
    },
    useSettingsStore: {
        getState: () => ({
            localCache: {
                imageVariants: {
                    format: 'webp',
                    mode: 'downscale',
                    quality: 82,
                    variants: {
                        fullScreen: { enabled: true, px: 0 },
                        header: { enabled: true, px: 300 },
                        itemCard: { enabled: true, px: 300 },
                        sidebar: { enabled: false, px: 400 },
                        table: { enabled: true, px: 80 },
                    },
                },
            },
        }),
    },
}));

import {
    imageVariantsInternals,
    resolveThumbnail,
    rewriteUrlToVariantSize,
} from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

let urlCounter = 0;

beforeEach(() => {
    urlCounter = 0;
    mocks.store.clear();
    mocks.thumbnailsTable.get.mockClear();
    mocks.thumbnailsTable.put.mockClear();
    mocks.thumbnailsTable.update.mockClear();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.clearAllMocks();
});

const okResponse = (bytes = 8192) =>
    ({
        blob: async () => new Blob([new Uint8Array(bytes)]),
        headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
        },
        ok: true,
        status: 200,
    }) as unknown as Response;

const notFoundResponse = () =>
    ({
        blob: async () => new Blob([]),
        headers: { get: () => null },
        ok: false,
        status: 404,
    }) as unknown as Response;

describe('resolveThumbnail — variant keying', () => {
    it('writes and reads a row keyed by [itemId, variant]', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        const out = await resolveThumbnail('abc', 'table', RAW_URL);
        expect(out).toMatch(/^blob:mock\//);

        // The persisted row is keyed under the table variant and carries the
        // bucket + format on the row payload.
        const row = mocks.store.get(JSON.stringify(['abc', 'table']));
        expect(row).toBeTruthy();
        expect(row.Variant).toBe('table');
        expect(row.Format).toBe('jpeg');
        expect(row.Blob).toBeInstanceOf(Blob);

        // A second resolve for the same variant is now a cache HIT (reads the
        // stored row, no second fetch).
        const before = (globalThis.fetch as any).mock.calls.length;
        const out2 = await resolveThumbnail('abc', 'table', RAW_URL);
        expect(out2).toMatch(/^blob:mock\//);
        expect((globalThis.fetch as any).mock.calls.length).toBe(before);
        // The get was called with the compound key.
        expect(mocks.thumbnailsTable.get).toHaveBeenCalledWith(['abc', 'table']);
    });

    it('dedups concurrent resolves for the SAME (item, variant) into one fetch', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        const [a, b, c] = await Promise.all([
            resolveThumbnail('abc', 'table', RAW_URL),
            resolveThumbnail('abc', 'table', RAW_URL),
            resolveThumbnail('abc', 'table', RAW_URL),
        ]);

        expect(a).toMatch(/^blob:mock\//);
        expect(b).toMatch(/^blob:mock\//);
        expect(c).toMatch(/^blob:mock\//);
        // One shared upstream fetch across all three concurrent acquires.
        expect((globalThis.fetch as any).mock.calls.length).toBe(1);
    });

    it('does NOT dedup different variants of the same item against each other', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await Promise.all([
            resolveThumbnail('abc', 'table', RAW_URL),
            resolveThumbnail('abc', 'itemCard', RAW_URL),
        ]);

        // Two distinct variants => two upstream fetches.
        expect((globalThis.fetch as any).mock.calls.length).toBe(2);
        expect(mocks.store.get(JSON.stringify(['abc', 'table']))).toBeTruthy();
        expect(mocks.store.get(JSON.stringify(['abc', 'itemCard']))).toBeTruthy();
    });

    it('keeps the negative-cache (MissAt) marker per-variant', async () => {
        // `table` 404s; `itemCard` succeeds. The miss marker must land on the
        // table row only and must not suppress the itemCard fetch.
        globalThis.fetch = vi.fn(async (input: any) => {
            const url = typeof input === 'string' ? input : String(input);
            // Both requests target the same raw URL; differentiate by call
            // order: first call (table) 404s, second (itemCard) succeeds.
            void url;
            return undefined as any;
        }) as unknown as typeof fetch;

        // First: table -> 404
        (globalThis.fetch as any).mockResolvedValueOnce(notFoundResponse());
        const tableOut = await resolveThumbnail('abc', 'table', RAW_URL);
        // 404 with nothing else cached for the item => the authoritative
        // no-artwork sentinel (NOT the raw URL — re-fetching it would 404
        // again, or hang against an unreachable server).
        expect(tableOut).toBe('feishin://no-artwork');

        const tableRow = mocks.store.get(JSON.stringify(['abc', 'table']));
        expect(tableRow).toBeTruthy();
        expect(tableRow.Blob).toBeUndefined();
        expect(typeof tableRow.MissAt).toBe('number');
        expect(tableRow.Variant).toBe('table');

        // The itemCard variant has NO marker yet and resolves independently.
        expect(mocks.store.get(JSON.stringify(['abc', 'itemCard']))).toBeUndefined();

        (globalThis.fetch as any).mockResolvedValueOnce(okResponse());
        const cardOut = await resolveThumbnail('abc', 'itemCard', RAW_URL);
        expect(cardOut).toMatch(/^blob:mock\//);
        const cardRow = mocks.store.get(JSON.stringify(['abc', 'itemCard']));
        expect(cardRow.Blob).toBeInstanceOf(Blob);

        // A subsequent table resolve is suppressed by its own fresh miss
        // marker — NO extra fetch beyond the two already made (the per-variant
        // negative cache is honoured). Because the larger `itemCard` variant is
        // now cached for this same item, the resolver serves it via the
        // nearest-larger fallback rather than blocking on the raw URL.
        const callsBefore = (globalThis.fetch as any).mock.calls.length;
        const tableAgain = await resolveThumbnail('abc', 'table', RAW_URL);
        expect(tableAgain).toMatch(/^blob:mock\//);
        expect((globalThis.fetch as any).mock.calls.length).toBe(callsBefore);
    });
});

describe('rewriteUrlToVariantSize', () => {
    it('rewrites size-bearing query params to the target px', () => {
        const out = rewriteUrlToVariantSize(
            'https://s.example/img?width=1024&height=1024&size=1024',
            80,
        );
        const parsed = new URL(out);
        expect(parsed.searchParams.get('width')).toBe('80');
        expect(parsed.searchParams.get('height')).toBe('80');
        expect(parsed.searchParams.get('size')).toBe('80');
    });

    it('covers the wider Jellyfin family + Subsonic params', () => {
        const out = rewriteUrlToVariantSize(
            'https://s.example/img?fillWidth=1024&fillHeight=1024&maxWidth=1024&maxHeight=1024&imageSize=1024',
            300,
        );
        const parsed = new URL(out);
        expect(parsed.searchParams.get('fillWidth')).toBe('300');
        expect(parsed.searchParams.get('fillHeight')).toBe('300');
        expect(parsed.searchParams.get('maxWidth')).toBe('300');
        expect(parsed.searchParams.get('maxHeight')).toBe('300');
        expect(parsed.searchParams.get('imageSize')).toBe('300');
    });

    it('px 0 (original) strips size params entirely', () => {
        const out = rewriteUrlToVariantSize('https://s.example/img?width=1024&height=1024', 0);
        const parsed = new URL(out);
        expect(parsed.searchParams.has('width')).toBe(false);
        expect(parsed.searchParams.has('height')).toBe(false);
    });

    it('returns the URL unchanged when there is nothing to rewrite', () => {
        const url = 'https://s.example/img';
        expect(rewriteUrlToVariantSize(url, 80)).toBe(url);
    });

    it('returns unparseable URLs unchanged', () => {
        const weird = 'capacitor-electron://x{not a url}';
        expect(rewriteUrlToVariantSize(weird, 80)).toBe(weird);
    });
});

describe('resolveThumbnail — nearest-larger fallback on miss', () => {
    it('serves a cached larger variant and schedules a background generate', async () => {
        // Only the itemCard (300px) variant is cached for this item; nothing
        // is cached for the requested `table` (80px) bucket.
        const cardBlob = new Blob([new Uint8Array(12345)]);
        mocks.store.set(JSON.stringify(['xyz', 'itemCard']), {
            __cachedAt: Date.now(),
            Blob: cardBlob,
            ByteSize: cardBlob.size,
            Format: 'jpeg',
            ItemId: 'xyz',
            LastUsed: Date.now(),
            Size: 300,
            Variant: 'itemCard',
        });

        // The exact `table` fetch fails (e.g. offline) — the resolver must NOT
        // simply fall back to the raw URL when a larger cached cover exists.
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;

        // The resolver invokes the scheduler through the internals holder so
        // tests can intercept the (debounced, network-bound) background
        // generate without firing a real one.
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('xyz', 'table', RAW_URL);

        // We got a blob: URL — minted from the itemCard fallback blob, not the
        // raw fallback URL.
        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(cardBlob);

        // A background generate for the exact requested variant was scheduled.
        expect(scheduleSpy).toHaveBeenCalledWith('xyz', 'table', expect.anything());

        scheduleSpy.mockRestore();
    });

    it('falls back to the raw URL when no variant is cached for the item', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;

        const out = await resolveThumbnail('nope', 'table', RAW_URL);
        expect(out).toBe(RAW_URL);
    });
});
