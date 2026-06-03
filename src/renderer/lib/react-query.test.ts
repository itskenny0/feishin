import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { markServerReachable, markServerUnreachable } from './network-status';
// Importing './react-query' registers the onlineManager event listener as a
// module side-effect, so the act of importing wires the manager to
// navigator.onLine.
import './react-query';

const setNavigatorOnline = (value: boolean) => {
    Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        get: () => value,
    });
};

// Regression guard for the search/query deadlock.
//
// Previously `onlineManager` was driven by the COMBINED connectivity signal
// (navigator.onLine AND serverReachable). A single transport error flipped
// serverReachable=false, which paused every TanStack query — and a paused query
// never issues a request, so serverReachable could never flip back true. Search
// (and everything) silently stopped firing requests with no self-recovery.
//
// The fix wires onlineManager to navigator.onLine ALONE, so a server blip can
// never permanently pause queries.
describe('onlineManager is not paused by a transient server-unreachable blip', () => {
    beforeEach(() => {
        setNavigatorOnline(true);
        markServerReachable();
        // Nudge the manager to re-read navigator.onLine.
        window.dispatchEvent(new Event('online'));
    });

    afterEach(() => {
        setNavigatorOnline(true);
        markServerReachable();
        window.dispatchEvent(new Event('online'));
    });

    it('stays online (queries not paused) when ONLY the server is unreachable', () => {
        expect(onlineManager.isOnline()).toBe(true);

        // A transport error flips serverReachable=false. This must NOT pause
        // queries — otherwise no request can fire to ever recover.
        markServerUnreachable();

        expect(onlineManager.isOnline()).toBe(true);
    });

    it('does pause when the OS link genuinely drops, and resumes on online', () => {
        setNavigatorOnline(false);
        window.dispatchEvent(new Event('offline'));
        expect(onlineManager.isOnline()).toBe(false);

        // The browser fires `online` when the link returns — self-recovering.
        setNavigatorOnline(true);
        window.dispatchEvent(new Event('online'));
        expect(onlineManager.isOnline()).toBe(true);
    });
});
