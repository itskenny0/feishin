// Unit tests for the variant-aware thumbnail sweep (schema v11+).
//
// The sweep HONORS whatever variants are enabled. In DOWNLOAD mode it fans out
// one work unit per (item × enabled variant); in DOWNSCALE mode it emits ONE
// unit per item (the worker fetches the cover once at the largest enabled px
// and produces every enabled variant locally). Pre-caching the full-resolution
// original (the fullScreen variant, px:0) is OPT-IN and OFF by default — when
// disabled, originals are simply not swept (they load lazily on demand); when a
// user enables it, the sweep pre-caches them too. Empty `variants` (none
// enabled) short-circuits to an empty queue.

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

// Base config with the original (fullScreen) variant ENABLED — exercises the
// opt-in path. The shipping default has fullScreen DISABLED (see the
// "default (fullScreen off)" cases below).
const WITH_ORIGINAL: LocalCacheImageVariants = {
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

// The shipping default: fullScreen (original) OFF.
const DEFAULT_OFF: LocalCacheImageVariants = {
    ...WITH_ORIGINAL,
    variants: {
        ...WITH_ORIGINAL.variants,
        fullScreen: { enabled: false, px: 0 },
    },
};

const withMode = (
    cfg: LocalCacheImageVariants,
    mode: 'download' | 'downscale',
): LocalCacheImageVariants => ({ ...cfg, mode });

beforeEach(() => {
    mocks.albums.length = 0;
    mocks.artists.length = 0;
    mocks.playlists.length = 0;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('collectPending — variant fan-out', () => {
    it('opt-in: download mode sweeps the original when fullScreen is enabled', async () => {
        mocks.albums.push({ Id: 'a1' });

        const pending = await collectPending(withMode(WITH_ORIGINAL, 'download'));

        // 4 enabled variants (table, itemCard, header, fullScreen — sidebar off).
        expect(pending).toHaveLength(4);
        expect(pending.map((p) => p.variant).sort()).toEqual([
            'fullScreen',
            'header',
            'itemCard',
            'table',
        ]);
        const byVariant = Object.fromEntries(pending.map((p) => [p.variant, p.px]));
        expect(byVariant.table).toBe(80);
        expect(byVariant.itemCard).toBe(300);
        expect(byVariant.header).toBe(300);
        expect(byVariant.fullScreen).toBe(0);
    });

    it('opt-in: downscale mode fetches once at the original px when fullScreen is enabled', async () => {
        mocks.albums.push({ Id: 'a1' }, { Id: 'a2' });

        const pending = await collectPending(withMode(WITH_ORIGINAL, 'downscale'));

        expect(pending).toHaveLength(2);
        for (const unit of pending) {
            // Original (0) sorts largest, so the single fetch is at the original.
            expect(unit.px).toBe(0);
            expect((unit.downscaleVariants ?? []).map((v) => v.variant).sort()).toEqual([
                'fullScreen',
                'header',
                'itemCard',
                'table',
            ]);
        }
    });

    it('default (fullScreen off): download mode excludes the original', async () => {
        mocks.albums.push({ Id: 'a1' });

        const pending = await collectPending(withMode(DEFAULT_OFF, 'download'));

        // Only the small surface variants (table, itemCard, header).
        expect(pending).toHaveLength(3);
        expect(pending.map((p) => p.variant).sort()).toEqual(['header', 'itemCard', 'table']);
        expect(pending.some((p) => p.variant === 'fullScreen')).toBe(false);
        expect(pending.some((p) => p.px === 0)).toBe(false);
    });

    it('default (fullScreen off): downscale mode fetches at the largest small px (300, not original)', async () => {
        mocks.albums.push({ Id: 'a1' });
        mocks.artists.push({ Id: 'r1' });

        const pending = await collectPending(withMode(DEFAULT_OFF, 'downscale'));

        expect(pending).toHaveLength(2);
        for (const unit of pending) {
            expect(unit.px).toBe(300);
            expect((unit.downscaleVariants ?? []).map((v) => v.variant).sort()).toEqual([
                'header',
                'itemCard',
                'table',
            ]);
        }
    });

    it('no enabled variants => empty pending (sweep skipped)', async () => {
        mocks.albums.push({ Id: 'a1' });

        const none: LocalCacheImageVariants = {
            ...WITH_ORIGINAL,
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

        // Default (fullScreen off) => 3 items × 3 small variants = 9 work units.
        const pending = await collectPending(withMode(DEFAULT_OFF, 'download'));
        expect(pending).toHaveLength(9);
    });
});
