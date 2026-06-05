/**
 * Pins the referential-stability contract of `useStableContainerQuery`.
 *
 * The home page threads a container-query result through every shelf's
 * `GridCarousel` (a `memo`'d component). The raw `useContainerQuery` produces a
 * fresh object — new `width`/`height` — on every ResizeObserver tick, which
 * busts those memos and re-renders the whole shelf tree on each observed pixel
 * change even though the carousels only read the boolean breakpoints. This
 * test asserts the stable variant:
 *
 *   1. keeps the SAME object identity when only width/height change, and
 *   2. produces a NEW identity when a breakpoint boolean actually crosses,
 *   3. always preserves the source `ref` (so the ResizeObserver stays attached).
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { type ContainerQueryResult, useStableContainerQuery } from './use-container-query';

const makeSource = (overrides: Partial<ContainerQueryResult> = {}): ContainerQueryResult => {
    const ref = (() => {}) as unknown as ContainerQueryResult['ref'];
    return {
        height: 100,
        is2xl: false,
        is3xl: false,
        is4xl: false,
        is5xl: false,
        isCalculated: true,
        isLg: false,
        isMd: false,
        isSm: false,
        isXl: false,
        isXs: false,
        ref,
        width: 500,
        ...overrides,
    };
};

describe('useStableContainerQuery', () => {
    it('keeps identity stable across width/height-only changes', () => {
        const base = makeSource({ height: 100, width: 500 });
        const { rerender, result } = renderHook(({ source }) => useStableContainerQuery(source), {
            initialProps: { source: base },
        });

        const first = result.current;

        // Same breakpoints, different measured pixels (a ResizeObserver tick).
        rerender({ source: makeSource({ ...base, height: 101, ref: base.ref, width: 501 }) });

        expect(result.current).toBe(first);
    });

    it('creates a new identity when a breakpoint boolean crosses', () => {
        const base = makeSource({ isMd: false });
        const { rerender, result } = renderHook(({ source }) => useStableContainerQuery(source), {
            initialProps: { source: base },
        });

        const first = result.current;

        rerender({ source: makeSource({ ...base, isMd: true, ref: base.ref }) });

        expect(result.current).not.toBe(first);
        expect(result.current.isMd).toBe(true);
    });

    it('preserves the source ref', () => {
        const base = makeSource();
        const { result } = renderHook(() => useStableContainerQuery(base));
        expect(result.current.ref).toBe(base.ref);
    });
});
