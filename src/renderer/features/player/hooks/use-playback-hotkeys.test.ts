/**
 * Regression: `usePlaybackHotkeys` (and a handful of sibling hooks fed by
 * `audio-players.tsx`) previously called `usePlayerStore()` with no
 * selector, which subscribed them to *every* mutation of the player slice
 * (timestamp ticks, queue mutations, volume changes…) and rebuilt the
 * `playbackHotkeysItems` array on each one.
 *
 * The hooks now pull the actions through `usePlayerActions`, whose returned
 * record is memoised and only flips identity when the action references in
 * the underlying store actually change (effectively never after mount). This
 * test pins that contract so an accidental revert to a wide selector trips.
 *
 * We don't try to render the hotkeys hook itself — `useHotkeys` and friends
 * need a DOM and a router context we don't want to set up here. Instead we
 * drive the underlying store directly and assert what `usePlayerActions`
 * returns.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usePlayerActions, usePlayerStoreBase } from '/@/renderer/store/player.store';

describe('usePlayerActions leaf subscription', () => {
    it('returns a stable reference across unrelated player-state mutations', () => {
        // eslint-disable-next-line perfectionist/sort-objects -- @testing-library destructure order
        const { rerender, result } = renderHook(() => usePlayerActions());

        const firstSnapshot = result.current;
        expect(typeof firstSnapshot.mediaPlay).toBe('function');
        expect(typeof firstSnapshot.toggleShuffle).toBe('function');

        // Mutate an unrelated slice (volume). A wide selector would re-fire
        // every consumer; the leaf selector inside usePlayerActions should
        // not see this and the memoised record must keep the same identity.
        act(() => {
            usePlayerStoreBase.getState().setVolume(42);
        });

        rerender();
        expect(result.current).toBe(firstSnapshot);

        act(() => {
            usePlayerStoreBase.setState((state) => {
                state.player.muted = !state.player.muted;
            });
        });

        rerender();
        expect(result.current).toBe(firstSnapshot);
    });
});
