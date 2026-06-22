/**
 * Settings-store migration coverage. Each test seeds a persisted
 * `store_settings` blob at an old version, imports the store fresh, and
 * asserts on the rehydrated state — the same path a real upgrade takes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seed = (state: Record<string, unknown>, version: number) => {
    localStorage.setItem('store_settings', JSON.stringify({ state, version }));
};

const loadStore = async () => {
    vi.resetModules();
    const module = await import('/@/renderer/store/settings.store');
    return module.useSettingsStore;
};

// Each test re-imports the settings store from scratch (vi.resetModules +
// dynamic import of the full zod schema graph) — fast standalone but slow
// enough under full-suite worker contention to trip the default 5s timeout.
describe('settings migrations', { timeout: 20_000 }, () => {
    beforeEach(() => {
        localStorage.clear();
    });

    // The iPod-vs-phone MQTT discovery bug (device, 2026-06-10): the v48→49
    // wizard migration set onboarded=false for EVERY existing install,
    // including ones with peerSync.enabled=true and a configured broker.
    // Those installs keep their broker settings (UI looks configured) but
    // the subsystem mount gates on enabled && jellyfinRemoteEnabled &&
    // onboarded, so MQTT silently never boots again.
    it('grandfathers enabled peer-sync installs into onboarded', async () => {
        seed(
            {
                peerSync: {
                    brokerUrl: 'ws://192.168.0.10:1884',
                    enabled: true,
                    jellyfinRemoteEnabled: true,
                    onboarded: false,
                    peerId: 'abc123',
                },
            },
            61,
        );

        const store = await loadStore();
        expect(store.getState().peerSync.onboarded).toBe(true);
    });

    it('leaves never-enabled installs un-onboarded', async () => {
        seed(
            {
                peerSync: {
                    enabled: false,
                    onboarded: false,
                },
            },
            61,
        );

        const store = await loadStore();
        expect(store.getState().peerSync.onboarded).toBe(false);
    });

    // v62 preserved stale persisted order that the redesigned home had been
    // ignoring — honoring it reshuffled everyone's homepage (reported on
    // device, 2026-06-11). v63 resets to the canonical order once.
    it('resets home sections to canonical order (stale pre-redesign order)', async () => {
        seed(
            {
                general: {
                    homeItems: [
                        { disabled: true, id: 'recentlyPlayed' },
                        { disabled: false, id: 'libraryStats' }, // dead id
                        { disabled: false, id: 'random' },
                    ],
                },
            },
            61,
        );

        const store = await loadStore();
        const items = store.getState().general.homeItems;
        const ids = items.map((i) => i.id);
        expect(ids).not.toContain('libraryStats');
        expect(ids).toContain('quickPicks');
        expect(ids).toContain('pinned');
        // Canonical order with the lean default flags: pinned / quick picks /
        // recently played / most played / playlists on, the rest opt-in.
        expect(ids[0]).toBe('pinned');
        const enabled = items.filter((i) => !i.disabled).map((i) => i.id);
        expect(enabled).toEqual([
            'pinned',
            'quickPicks',
            'recentlyPlayed',
            'mostPlayed',
            'playlists',
        ]);
    });

    it('also resets v62-migrated blobs (order regression shipped in 0008)', async () => {
        seed(
            {
                general: {
                    homeItems: [
                        { disabled: false, id: 'random' },
                        { disabled: false, id: 'recentlyPlayed' },
                    ],
                },
            },
            62,
        );

        const store = await loadStore();
        const ids = store.getState().general.homeItems.map((i) => i.id);
        expect(ids[0]).toBe('pinned');
        expect(ids.length).toBeGreaterThan(8);
    });

    it('normalizes the retired waveform seekbar view back to the slider', async () => {
        seed(
            {
                general: {
                    playerbarSlider: { barAlign: 'center', type: 'waveform' },
                },
            },
            61,
        );

        const store = await loadStore();
        expect(store.getState().general.playerbarSlider.type).toBe('slider');
    });

    it('survives a sparse blob without the peerSync slice', async () => {
        seed({}, 61);

        const store = await loadStore();
        // Migration must not throw (a throwing migrate wipes ALL settings);
        // defaults apply.
        expect(store.getState().peerSync.onboarded).toBe(false);
        expect(store.getState().peerSync.enabled).toBe(false);
    });

    // v70→71: server-resize ("download") becomes the default thumbnail mode.
    // Existing installs persisted at the legacy client-side "downscale" mode
    // are flipped so their resync uses the fast no-client-encode path.
    it('flips an existing downscale install to download mode (v70→71)', async () => {
        seed(
            {
                localCache: {
                    enabled: true,
                    imageVariants: {
                        format: 'webp',
                        mode: 'downscale',
                        quality: 82,
                        variants: {
                            fullScreen: { enabled: false, px: 0 },
                            header: { enabled: true, px: 300 },
                            itemCard: { enabled: true, px: 300 },
                            sidebar: { enabled: true, px: 400 },
                            table: { enabled: true, px: 80 },
                        },
                    },
                },
            },
            70,
        );

        const store = await loadStore();
        expect(store.getState().localCache.imageVariants?.mode).toBe('download');
        // The rest of the user's variant config is preserved (only mode flips).
        expect(store.getState().localCache.imageVariants?.variants.table).toEqual({
            enabled: true,
            px: 80,
        });
    });

    it('survives a sparse blob without the imageVariants slice (v70→71)', async () => {
        seed({ localCache: { enabled: true } }, 70);

        // Migration must not throw (a throwing migrate wipes ALL settings).
        const store = await loadStore();
        // Falls back to the shipped default, which is download.
        expect(store.getState().localCache.imageVariants?.mode).toBe('download');
    });

    // v71→72: disable the redundant `header` bucket (same px as itemCard) to cut
    // ~25% of thumbnail-sync work; header surfaces serve from the cached itemCard.
    it('disables the redundant header bucket when it matches itemCard px (v71→72)', async () => {
        seed(
            {
                localCache: {
                    enabled: true,
                    imageVariants: {
                        format: 'webp',
                        mode: 'download',
                        quality: 82,
                        variants: {
                            fullScreen: { enabled: false, px: 0 },
                            header: { enabled: true, px: 300 },
                            itemCard: { enabled: true, px: 300 },
                            sidebar: { enabled: true, px: 400 },
                            table: { enabled: true, px: 80 },
                        },
                    },
                },
            },
            71,
        );

        const store = await loadStore();
        const vs = store.getState().localCache.imageVariants?.variants;
        expect(vs?.header.enabled).toBe(false);
        // The others are untouched.
        expect(vs?.itemCard.enabled).toBe(true);
        expect(vs?.sidebar.enabled).toBe(true);
        expect(vs?.table.enabled).toBe(true);
    });

    it('KEEPS a header bucket the user set to a DISTINCT px (v71→72)', async () => {
        seed(
            {
                localCache: {
                    enabled: true,
                    imageVariants: {
                        format: 'webp',
                        mode: 'download',
                        quality: 82,
                        variants: {
                            fullScreen: { enabled: false, px: 0 },
                            header: { enabled: true, px: 600 }, // distinct from itemCard
                            itemCard: { enabled: true, px: 300 },
                            sidebar: { enabled: true, px: 400 },
                            table: { enabled: true, px: 80 },
                        },
                    },
                },
            },
            71,
        );

        const store = await loadStore();
        // A header at a distinct size is a real bucket — left enabled.
        expect(store.getState().localCache.imageVariants?.variants.header.enabled).toBe(true);
    });
});
