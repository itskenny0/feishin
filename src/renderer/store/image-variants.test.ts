import { describe, expect, it } from 'vitest';

import { useImageVariants, useSettingsStore } from '/@/renderer/store/settings.store';

describe('localCache.imageVariants settings slice', () => {
    it('defaults imageVariants to the surface-bucket config', () => {
        const { imageVariants } = useSettingsStore.getState().localCache;

        // Sync-only: every size is cached (fullScreen capped at 1080px) and
        // autoPreset stays off so a sync never tunes the set down. `header`
        // is served from the pixel-identical itemCard bucket.
        expect(imageVariants).toEqual({
            autoPreset: false,
            format: 'webp',
            mode: 'download',
            quality: 82,
            variants: {
                fullScreen: { enabled: true, px: 1080 },
                header: { enabled: false, px: 300 },
                itemCard: { enabled: true, px: 300 },
                sidebar: { enabled: true, px: 400 },
                table: { enabled: true, px: 80 },
            },
        });
    });

    it('setLocalCache merges only the changed field', () => {
        const prev = useSettingsStore.getState().localCache.imageVariants!;

        useSettingsStore.getState().actions.setLocalCache({
            imageVariants: { ...prev, quality: 70 },
        });

        const next = useSettingsStore.getState().localCache.imageVariants!;
        expect(next.quality).toBe(70);
        // Everything else is untouched.
        expect(next.mode).toBe('download');
        expect(next.format).toBe('webp');
        expect(next.variants).toEqual(prev.variants);
    });

    it('exposes a useImageVariants selector hook', () => {
        // The selector is a hook reading localCache.imageVariants.
        expect(typeof useImageVariants).toBe('function');
        expect(useSettingsStore.getState().localCache.imageVariants?.mode).toBe('download');
    });
});
