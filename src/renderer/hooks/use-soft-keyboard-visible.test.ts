/**
 * Pins the soft-keyboard detection contract of `useSoftKeyboardVisible`.
 *
 * The hook drives the mobile mini-player's hide-while-typing behaviour. We
 * have no native `@capacitor/keyboard` plugin, so detection rides on
 * `window.visualViewport`: when the on-screen keyboard opens, the visual
 * viewport shrinks while the layout viewport (`window.innerHeight`) stays put.
 * A shrink past the threshold ⇒ keyboard considered visible.
 *
 * These tests drive a mocked `visualViewport` and assert:
 *   1. shrinking the visual viewport past the threshold flips to `true`,
 *   2. restoring it flips back to `false`,
 *   3. a sub-threshold shrink (e.g. browser chrome) does NOT trip it,
 *   4. when gating is off (non-touch / desktop) it always reports `false`.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSoftKeyboardVisible } from './use-soft-keyboard-visible';

interface MockVisualViewport {
    addEventListener: (type: string, cb: () => void) => void;
    dispatch: () => void;
    height: number;
    removeEventListener: (type: string, cb: () => void) => void;
}

const makeViewport = (height: number): MockVisualViewport => {
    const listeners = new Set<() => void>();
    return {
        addEventListener: (_type, cb) => listeners.add(cb),
        dispatch: () => listeners.forEach((cb) => cb()),
        height,
        removeEventListener: (_type, cb) => listeners.delete(cb),
    };
};

const originalViewport = window.visualViewport;
const originalInnerHeight = window.innerHeight;

let viewport: MockVisualViewport;

beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 800,
        writable: true,
    });
    viewport = makeViewport(800);
    Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: viewport,
        writable: true,
    });
});

afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: originalViewport,
        writable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
        writable: true,
    });
    vi.restoreAllMocks();
});

describe('useSoftKeyboardVisible', () => {
    it('reports visible when the visual viewport shrinks past the threshold', () => {
        const { result } = renderHook(() => useSoftKeyboardVisible({ enabled: true }));
        expect(result.current).toBe(false);

        act(() => {
            // Keyboard opens: visual viewport shrinks ~340px (well past 150).
            viewport.height = 460;
            viewport.dispatch();
        });

        expect(result.current).toBe(true);
    });

    it('reports hidden again when the viewport is restored', () => {
        const { result } = renderHook(() => useSoftKeyboardVisible({ enabled: true }));

        act(() => {
            viewport.height = 460;
            viewport.dispatch();
        });
        expect(result.current).toBe(true);

        act(() => {
            viewport.height = 800;
            viewport.dispatch();
        });
        expect(result.current).toBe(false);
    });

    it('ignores a sub-threshold shrink (e.g. transient browser chrome)', () => {
        const { result } = renderHook(() => useSoftKeyboardVisible({ enabled: true }));

        act(() => {
            // 90px shrink < 150px threshold.
            viewport.height = 710;
            viewport.dispatch();
        });

        expect(result.current).toBe(false);
    });

    it('always reports hidden when gating is disabled', () => {
        const { result } = renderHook(() => useSoftKeyboardVisible({ enabled: false }));

        act(() => {
            viewport.height = 460;
            viewport.dispatch();
        });

        expect(result.current).toBe(false);
    });
});
