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

// ---------------------------------------------------------------------------
// Self-healing reachability probe.
//
// `markServerUnreachable` latches the offline state until a *successful
// response* clears it. During the blocking first-sync the only traffic is the
// cache sweeps — and they PARK while offline, so they issue no request that
// could ever clear the latch. One slow cover (a 20s image timeout) therefore
// parks every sweep "offline" indefinitely while the device is foreground and
// the link is up (observed on-device: "starting paused — offline"). The probe
// is the missing recovery path: while latched unreachable it pings the server
// on an interval and clears the latch on the first response.
//
// The actual ping is REGISTERED by app init (cache/lifecycle.ts) rather than
// imported here, so this leaf module stays free of api/auth dependencies (which
// import it, back). With no probe registered (unit tests, SSR) nothing is
// scheduled — markServerUnreachable behaves exactly as before.
let reachabilityProbe: (() => Promise<boolean>) | null = null;
let probeTimer: null | ReturnType<typeof setInterval> = null;
let probeInFlight = false;
const PROBE_INTERVAL_MS = 6_000;

export const registerReachabilityProbe = (probe: () => Promise<boolean>): void => {
    reachabilityProbe = probe;
};

const stopReachabilityProbe = (): void => {
    if (probeTimer !== null) {
        clearInterval(probeTimer);
        probeTimer = null;
    }
};

const startReachabilityProbe = (): void => {
    if (probeTimer !== null || !reachabilityProbe || !hasWindow) return;
    probeTimer = setInterval(() => {
        // Single in-flight probe only — never stack requests on a recovering
        // server.
        if (probeInFlight || !reachabilityProbe) return;
        probeInFlight = true;
        reachabilityProbe()
            .then((reachable) => {
                if (reachable) {
                    console.info('[net] reachability probe succeeded — clearing offline latch');
                    markServerReachable();
                }
            })
            .catch(() => undefined)
            .finally(() => {
                probeInFlight = false;
            });
    }, PROBE_INTERVAL_MS);
};

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
    // Start the self-healing probe so the latch can clear even if no other
    // traffic runs (the first-sync sweep-park deadlock).
    startReachabilityProbe();
    emitIfChanged();
};

/**
 * Called by the axios clients on any successful response. Clears the
 * server-unreachable override.
 */
export const markServerReachable = (): void => {
    serverReachable = true;
    stopReachabilityProbe();
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
