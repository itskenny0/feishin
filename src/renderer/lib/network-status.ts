// Global connectivity detector.
//
// `navigator.onLine` is necessary but not sufficient on Electron/Capacitor
// WebViews: it frequently reports `true` while the configured media server is
// actually unreachable (captive portals, VPN drops, server down). So the
// effective online signal is the AND of two inputs:
//
//   1. `navigator.onLine` + the window `online`/`offline` events (OS-level link).
//   2. A `serverReachable` boolean the axios clients update from real request
//      outcomes — flipped false on a transport error (ERR_NETWORK / timeout),
//      flipped true on any successful response.
//
// Consumers (TanStack `onlineManager`, the durable mutation worker, UI) listen
// for the `feishin:connectivity-change` CustomEvent on `window`, matching the
// existing `feishin:*` event convention used across the cache subsystem.

import { useSyncExternalStore } from 'react';

const CONNECTIVITY_EVENT = 'feishin:connectivity-change';

const hasWindow = typeof window !== 'undefined';

/**
 * OS-level link status from `navigator.onLine`. This is the ONLY input that
 * drives TanStack's `onlineManager` (query pause/resume) — see the rationale on
 * `getIsOnline` below. Assumes online when the platform doesn't expose the flag
 * (SSR/tests).
 */
export const getNavigatorOnline = (): boolean => {
    if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
        return true;
    }
    return navigator.onLine;
};

// Internal alias kept so the rest of this module reads naturally.
const navigatorOnline = getNavigatorOnline;

// Tracks the server-reachability override. Starts optimistic — we only learn a
// server is unreachable once a real request fails, and we don't want to gate
// the very first request behind a pessimistic default.
let serverReachable = true;

// Last broadcast value, so we only emit/log on an actual edge transition.
let lastOnline = navigatorOnline() && serverReachable;

const computeOnline = (): boolean => navigatorOnline() && serverReachable;

const emitIfChanged = (): void => {
    const online = computeOnline();
    if (online === lastOnline) {
        return;
    }
    console.info(online ? '[net] offline → online' : '[net] online → offline');
    lastOnline = online;
    if (hasWindow) {
        window.dispatchEvent(new CustomEvent(CONNECTIVITY_EVENT, { detail: { online } }));
    }
};

if (hasWindow) {
    // The OS-level link transitions. We re-evaluate the combined signal: coming
    // back online at the OS level optimistically clears the server override so a
    // single failed-then-recovered request doesn't pin us offline forever.
    window.addEventListener('online', () => {
        serverReachable = true;
        emitIfChanged();
    });
    window.addEventListener('offline', () => {
        emitIfChanged();
    });
}

/**
 * Current combined connectivity snapshot (`navigator.onLine` AND
 * `serverReachable`). Cheap; safe to call frequently.
 *
 * IMPORTANT: this combined signal drives UX only (the NO_NETWORK route, the
 * `useIsOnline` hook, offline indicators) — it must NOT drive TanStack's
 * `onlineManager`. `serverReachable` flips false on a single transport error
 * (timeout / ERR_NETWORK) and can only recover via a *successful response*. If
 * the combined signal paused queries, that pause would itself prevent any
 * request from ever succeeding, so `serverReachable` could never flip back —
 * a permanent deadlock where "search (and everything) stops firing requests"
 * after one network blip. `onlineManager` is therefore wired to
 * `getNavigatorOnline()` (the self-recovering OS link) instead; see
 * `lib/react-query.ts`.
 */
export const getIsOnline = (): boolean => computeOnline();

/**
 * Called by the axios clients when a request fails with a transport-level
 * error (ERR_NETWORK / ECONNABORTED / ETIMEDOUT) — NOT for HTTP status errors
 * like 401/404/500, which mean the server is reachable and responding.
 */
export const markServerUnreachable = (): void => {
    if (serverReachable) {
        console.info('[net] server marked unreachable');
    }
    serverReachable = false;
    emitIfChanged();
};

/**
 * Called by the axios clients on any successful response. Clears the
 * server-unreachable override.
 */
export const markServerReachable = (): void => {
    serverReachable = true;
    emitIfChanged();
};

type Listener = () => void;

const listeners = new Set<Listener>();

const handleConnectivityEvent = (): void => {
    listeners.forEach((cb) => cb());
};

if (hasWindow) {
    window.addEventListener(CONNECTIVITY_EVENT, handleConnectivityEvent);
}

/**
 * Subscribe to connectivity transitions. Returns an unsubscribe function.
 * Intended for `useSyncExternalStore`.
 */
export const subscribeIsOnline = (cb: Listener): (() => void) => {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
};

/**
 * React hook returning the current combined connectivity snapshot. Re-renders
 * the consuming component on every offline↔online transition. Backed by
 * `subscribeIsOnline` / `getIsOnline` so it shares the single window listener
 * and tears down cleanly when the component unmounts.
 */
export const useIsOnline = (): boolean =>
    useSyncExternalStore(subscribeIsOnline, getIsOnline, getIsOnline);

export { CONNECTIVITY_EVENT };
