import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
    CrossfadeImageInputs,
    useCrossfadeImageSlots,
} from '/@/renderer/features/player/hooks/use-crossfade-image-slots';

const render = (initial: CrossfadeImageInputs) =>
    renderHook((props: CrossfadeImageInputs) => useCrossfadeImageSlots(props), {
        initialProps: initial,
    });

describe('useCrossfadeImageSlots', () => {
    it('seeds the top slot from the current image and starts on slot 0', () => {
        const { result } = render({
            currentImageUrl: 'blob:current',
            nextImageUrl: 'blob:next',
            songKey: 'song-1',
        });

        expect(result.current.current).toBe(0);
        expect(result.current.topImage).toBe('blob:current');
        expect(result.current.bottomImage).toBe('blob:next');
    });

    // The fullscreen-player bug (device, 2026-06-10): the cover URL resolves
    // asynchronously (Dexie lookup / network fetch), so mounting on an
    // already-playing song captures `undefined` and the old song-change-only
    // effect never adopted the late URL — placeholder forever while the
    // cache layer dutifully fetched bytes nobody displayed.
    it('adopts a late-resolving current image into the active slot (same song)', () => {
        const { rerender, result } = render({
            currentImageUrl: undefined,
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        expect(result.current.topImage).toBeUndefined();

        rerender({
            currentImageUrl: 'blob:resolved',
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        expect(result.current.current).toBe(0);
        expect(result.current.topImage).toBe('blob:resolved');
    });

    it('adopts a degraded→upgraded URL swap for the same song', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:degraded-table',
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        rerender({
            currentImageUrl: 'blob:fullscreen-upgrade',
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        expect(result.current.topImage).toBe('blob:fullscreen-upgrade');
    });

    it('keeps the last painted image when the URL transiently resolves to undefined', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:painted',
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        rerender({
            currentImageUrl: undefined,
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        expect(result.current.topImage).toBe('blob:painted');
    });

    it('flips slots on song change and shows the new current image', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:song1',
            nextImageUrl: 'blob:song2',
            songKey: 'song-1',
        });

        rerender({
            currentImageUrl: 'blob:song2',
            nextImageUrl: 'blob:song3',
            songKey: 'song-2',
        });

        expect(result.current.current).toBe(1);
        expect(result.current.bottomImage).toBe('blob:song2');
        // Inactive slot pre-seeds the upcoming track for the next flip.
        expect(result.current.topImage).toBe('blob:song3');
    });

    it('adopts a late URL into the bottom slot after a flip', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:song1',
            nextImageUrl: undefined,
            songKey: 'song-1',
        });

        // Skip to a song whose cover has not resolved yet.
        rerender({
            currentImageUrl: undefined,
            nextImageUrl: undefined,
            songKey: 'song-2',
        });
        expect(result.current.current).toBe(1);
        expect(result.current.bottomImage).toBeUndefined();

        rerender({
            currentImageUrl: 'blob:song2-late',
            nextImageUrl: undefined,
            songKey: 'song-2',
        });
        expect(result.current.bottomImage).toBe('blob:song2-late');
    });

    it('tracks explicit flags through flips', () => {
        const { rerender, result } = render({
            currentExplicit: true,
            currentImageUrl: 'blob:song1',
            nextExplicit: false,
            nextImageUrl: 'blob:song2',
            songKey: 'song-1',
        });

        expect(result.current.topExplicit).toBe(true);

        rerender({
            currentExplicit: false,
            currentImageUrl: 'blob:song2',
            nextExplicit: true,
            nextImageUrl: 'blob:song3',
            songKey: 'song-2',
        });

        expect(result.current.bottomExplicit).toBe(false);
        expect(result.current.topExplicit).toBe(true);
    });

    it('does nothing while paused (radio playback)', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:song1',
            nextImageUrl: undefined,
            paused: true,
            songKey: 'song-1',
        });

        rerender({
            currentImageUrl: 'blob:radio-art',
            nextImageUrl: undefined,
            paused: true,
            songKey: 'radio-station',
        });

        expect(result.current.current).toBe(0);
        expect(result.current.topImage).toBe('blob:song1');
    });
});
