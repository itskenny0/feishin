import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CONNECTIVITY_EVENT,
    getIsOnline,
    markServerReachable,
    markServerUnreachable,
    subscribeIsOnline,
    useIsOnline,
} from './network-status';

// The module reads navigator.onLine and emits on the window. jsdom provides
// both; we toggle navigator.onLine and listen for the CustomEvent.

const setNavigatorOnline = (value: boolean) => {
    Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => value,
    });
};

describe('network-status combined online signal', () => {
    beforeEach(() => {
        setNavigatorOnline(true);
        // Reset the server-reachable override to the optimistic default.
        markServerReachable();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setNavigatorOnline(true);
        markServerReachable();
    });

    it('is online when navigator.onLine and server reachable', () => {
        setNavigatorOnline(true);
        markServerReachable();
        expect(getIsOnline()).toBe(true);
    });

    it('is offline when the server is marked unreachable even if navigator says online', () => {
        setNavigatorOnline(true);
        markServerUnreachable();
        expect(getIsOnline()).toBe(false);
    });

    it('is offline when navigator.onLine is false', () => {
        setNavigatorOnline(false);
        markServerReachable();
        expect(getIsOnline()).toBe(false);
    });

    it('emits a connectivity-change event on a true→false transition', () => {
        markServerReachable();
        const handler = vi.fn();
        window.addEventListener(CONNECTIVITY_EVENT, handler);
        markServerUnreachable();
        expect(handler).toHaveBeenCalledTimes(1);
        const event = handler.mock.calls[0][0] as CustomEvent<{ online: boolean }>;
        expect(event.detail.online).toBe(false);
        window.removeEventListener(CONNECTIVITY_EVENT, handler);
    });

    it('does not emit when the combined signal is unchanged', () => {
        markServerUnreachable();
        const handler = vi.fn();
        window.addEventListener(CONNECTIVITY_EVENT, handler);
        // Already offline; marking unreachable again is a no-op edge.
        markServerUnreachable();
        expect(handler).not.toHaveBeenCalled();
        window.removeEventListener(CONNECTIVITY_EVENT, handler);
    });
});

describe('subscribeIsOnline', () => {
    beforeEach(() => {
        setNavigatorOnline(true);
        markServerReachable();
    });

    afterEach(() => {
        setNavigatorOnline(true);
        markServerReachable();
    });

    it('notifies subscribers on a transition and stops after unsubscribe', () => {
        const cb = vi.fn();
        const unsubscribe = subscribeIsOnline(cb);

        markServerUnreachable();
        expect(cb).toHaveBeenCalledTimes(1);

        markServerReachable();
        expect(cb).toHaveBeenCalledTimes(2);

        // Cleanup: after unsubscribe no further notifications arrive.
        unsubscribe();
        markServerUnreachable();
        expect(cb).toHaveBeenCalledTimes(2);
    });
});

describe('useIsOnline', () => {
    beforeEach(() => {
        setNavigatorOnline(true);
        markServerReachable();
    });

    afterEach(() => {
        setNavigatorOnline(true);
        markServerReachable();
    });

    it('reflects the current snapshot and re-renders on offline→online transitions', () => {
        const { result } = renderHook(() => useIsOnline());
        expect(result.current).toBe(true);

        act(() => {
            markServerUnreachable();
        });
        expect(result.current).toBe(false);

        act(() => {
            markServerReachable();
        });
        expect(result.current).toBe(true);
    });

    it('removes its listener on unmount (no leak)', () => {
        const { result, unmount } = renderHook(() => useIsOnline());
        expect(result.current).toBe(true);

        unmount();

        // A transition after unmount must not throw or keep the component
        // subscribed; the snapshot stays at whatever the last render captured.
        act(() => {
            markServerUnreachable();
        });
        expect(result.current).toBe(true);
    });
});
