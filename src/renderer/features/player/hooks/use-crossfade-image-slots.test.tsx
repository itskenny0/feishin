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

    // The crossfade artifact (device, 2026-07-03): `useCachedItemImageUrl`
    // seeds its `displaySrc` synchronously only on mount; on a REQUEST change
    // (song advance) it re-resolves in an effect, so on the render where the
    // song flips A→B, `currentImageUrl` is a render behind and STILL holds A's
    // URL. The inactive slot, however, was pre-seeded with B's cover (as the
    // `next` image) on a prior render. The flip must adopt that pre-seeded
    // upcoming cover into the newly-active slot — NOT the stale
    // `currentImageUrl`, which is what briefly flashed the just-left cover back
    // in (for seconds, when B was uncached).
    it('shows the pre-seeded upcoming cover, not the render-behind previous URL, on flip', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:songA',
            nextImageUrl: 'blob:songB',
            songKey: 'song-A',
        });

        // Inactive (bottom) slot now holds B's cover, pre-seeded as `next`.
        expect(result.current.bottomImage).toBe('blob:songB');

        // Song advances A→B, but the async resolver has not re-run yet:
        // `currentImageUrl` is a render behind and still reports A's URL, while
        // `nextImageUrl` has moved on to C.
        rerender({
            currentImageUrl: 'blob:songA',
            nextImageUrl: 'blob:songC',
            songKey: 'song-B',
        });

        expect(result.current.current).toBe(1);
        // The newly-active slot shows B (the pre-seeded upcoming cover) — the
        // stale A URL must NOT contaminate it.
        expect(result.current.bottomImage).toBe('blob:songB');
        expect(result.current.bottomImage).not.toBe('blob:songA');
        // Outgoing/inactive slot pre-seeds the new upcoming track (C).
        expect(result.current.topImage).toBe('blob:songC');
    });

    // No cross-song contamination across rapid, faster-than-resolution flips:
    // A→B→C where `currentImageUrl` is always a render behind. Each flip must
    // land the correctly pre-seeded upcoming cover in the active slot and never
    // resurrect a two-songs-ago cover, even before the current song resolves.
    it('never lets a past cover contaminate the active slot across rapid flips', () => {
        const { rerender, result } = render({
            currentImageUrl: 'blob:songA',
            nextImageUrl: 'blob:songB',
            songKey: 'song-A',
        });

        // A→B: current is a render behind (still A); next has advanced to C.
        rerender({
            currentImageUrl: 'blob:songA',
            nextImageUrl: 'blob:songC',
            songKey: 'song-B',
        });
        expect(result.current.current).toBe(1);
        expect(result.current.bottomImage).toBe('blob:songB');
        expect(result.current.bottomImage).not.toBe('blob:songA');

        // B→C before B ever resolved: current is a render behind (now B); next
        // has advanced to D. The active slot must show C (pre-seeded on the
        // previous flip), NOT B (previous song) and certainly NOT A.
        rerender({
            currentImageUrl: 'blob:songB',
            nextImageUrl: 'blob:songD',
            songKey: 'song-C',
        });
        expect(result.current.current).toBe(0);
        expect(result.current.topImage).toBe('blob:songC');
        expect(result.current.topImage).not.toBe('blob:songB');
        expect(result.current.topImage).not.toBe('blob:songA');

        // C finally resolves for the (unchanged) current song — a legitimate
        // same-song adoption, and a no-op here since C already shows.
        rerender({
            currentImageUrl: 'blob:songC',
            nextImageUrl: 'blob:songD',
            songKey: 'song-C',
        });
        expect(result.current.topImage).toBe('blob:songC');
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
