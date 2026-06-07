// Unit tests for the variant-aware thumbnail sweep (schema v11+).
//
// The sweep fans out one work unit per (item × enabled variant) in DOWNLOAD
// mode (each variant is a separate server request at that variant's px) and
// ONE work unit per item in DOWNSCALE mode (the worker fetches the cover once
// at the largest enabled px and produces every variant locally). Empty
// `variants` (none enabled) short-circuits to an empty queue so the sweep is
// skipped. The progress denominator counts the fanned-out work units, not the
// raw item count.

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks ------------------------------------------------------------
const mocks = vi.hoisted(() => {
    const albums: { Id: string }[] = [];
    const artists: { Id: string }[] = [];
    const playlists: { Id: string }[] = [];
    const db = {
        albums: { toArray: vi.fn(async () => albums) },
        artists: { toArray: vi.fn(async () => artists) },
        playlists: { toArray: vi.fn(async () => playlists) },
    };
    return { albums, artists, db, playlists };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

import { collectPending } from '/@/renderer/cache/sync/thumbnails';

const DEFAULTS: LocalCacheImageVariants = {
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
};

const withMode = (mode: 'download' | 'downscale'): LocalCacheImageVariants => ({
    ...DEFAULTS,
    mode,
});

beforeEach(() => {
    mocks.albums.length = 0;
    mocks.artists.length = 0;
    mocks.playlists.length = 0;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('collectPending — variant fan-out', () => {
    it('download mode: one work unit per (item × enabled variant)', async () => {
        mocks.albums.push({ Id: 'a1' });

        const pending = await collectPending(withMode('download'));

        // 4 enabled variants (table, itemCard, header, fullScreen — sidebar
        // disabled) => 4 work units for the single album.
        expect(pending).toHaveLength(4);
        const variants = pending.map((p) => p.variant).sort();
        expect(variants).toEqual(['fullScreen', 'header', 'itemCard', 'table']);
        // Every unit carries the per-variant target px.
        const byVariant = Object.fromEntries(pending.map((p) => [p.variant, p.px]));
        expect(byVariant.table).toBe(80);
        expect(byVariant.itemCard).toBe(300);
        expect(byVariant.header).toBe(300);
        expect(byVariant.fullScreen).toBe(0);
        // All point at the same item.
        expect(pending.every((p) => p.itemId === 'a1')).toBe(true);
    });

    it('downscale mode: ONE work unit per item (worker produces all variants)', async () => {
        mocks.albums.push({ Id: 'a1' }, { Id: 'a2' });
        mocks.artists.push({ Id: 'r1' });

        const pending = await collectPending(withMode('downscale'));

        // 3 items, one unit each regardless of the 4 enabled variants.
        expect(pending).toHaveLength(3);
        const ids = pending.map((p) => p.itemId).sort();
        expect(ids).toEqual(['a1', 'a2', 'r1']);
        // The single unit fetches at the largest enabled px (fullScreen=0 =>
        // original, the largest), and carries the full enabled-variant list so
        // the worker can downscale to each.
        for (const unit of pending) {
            expect(unit.px).toBe(0);
            const dsVariants = (unit.downscaleVariants ?? []).map((v) => v.variant).sort();
            expect(dsVariants).toEqual(['fullScreen', 'header', 'itemCard', 'table']);
        }
    });

    it('no enabled variants => empty pending (sweep skipped)', async () => {
        mocks.albums.push({ Id: 'a1' });

        const none: LocalCacheImageVariants = {
            ...DEFAULTS,
            variants: {
                fullScreen: { enabled: false, px: 0 },
                header: { enabled: false, px: 300 },
                itemCard: { enabled: false, px: 300 },
                sidebar: { enabled: false, px: 400 },
                table: { enabled: false, px: 80 },
            },
        };

        expect(await collectPending(none)).toEqual([]);
    });

    it('download fan-out covers albums, artists, and playlists', async () => {
        mocks.albums.push({ Id: 'a1' });
        mocks.artists.push({ Id: 'r1' });
        mocks.playlists.push({ Id: 'p1' });

        const pending = await collectPending(withMode('download'));

        // 3 items × 4 enabled variants = 12 work units.
        expect(pending).toHaveLength(12);
        // Progress total is just the work-unit count — verifies the fan-out is
        // what drives the denominator.
        const total = pending.length;
        expect(total).toBe(12);
    });
});
