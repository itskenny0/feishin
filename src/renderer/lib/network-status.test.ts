import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CONNECTIVITY_EVENT,
    getIsOnline,
    markServerReachable,
    markServerUnreachable,
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
