// Pure, side-effect-free logic for the sync gate. Kept framework-agnostic so
// the "is the first full sync complete?" decision can be unit-tested directly
// (drive entity toggles + hydration states, assert the gate verdict) without
// mounting React or touching Dexie.
//
// The gate blocks the whole authenticated app behind the SyncDashboard until
// the first full sync completes. "Complete" = every ENABLED library entity has
// reached hydrationState `full`. Thumbnails are intentionally NOT required:
// they're opt-in (driven by `thumbnailSizes`) and a huge cover sweep must not
// keep the app hostage — covers fill in lazily after release.

import type { HydrationState } from '../types';

// The library entities the gate cares about. Order mirrors the dashboard /
// hydrate() sweep order. Thumbnails are excluded by design (see header).
export const GATE_ENTITIES = [
    'artists',
    'genres',
    'albums',
    'songs',
    'lyrics',
    'playlists',
    'favorites',
] as const;

export type GateEntity = (typeof GATE_ENTITIES)[number];

// Per-entity opt-out map from `localCache.entities`. Missing / undefined ⇒ ON
// (matches hydrate()'s entityEnabled()).
export type GateEntityToggles = Partial<Record<GateEntity, boolean>> | undefined;

export interface GateStateInput {
    // Whether the cache subsystem probe succeeded (useCacheStore.cacheAvailable).
    cacheAvailable: boolean | undefined;
    // Whether the local cache is enabled (always true now, but kept explicit so
    // the gate stays inert if a future toggle disables it).
    enabled: boolean;
    // Per-entity opt-out toggles from settings.
    entityToggles: GateEntityToggles;
    // Live hydration states from the cache store (seeded from syncMeta on boot).
    hydrationStates: Partial<Record<string, HydrationState>>;
    // Persisted per-server completion record (settings.localCache.firstSyncComplete).
    persistedComplete: undefined | { at: number; partial: boolean };
    // The active server (must be a Jellyfin server with a userId for the cache
    // to apply). Null when no server / non-Jellyfin.
    server: null | { id: string; type: string; userId?: null | string };
}

export type GateVerdict =
    // Gate is not applicable — render the app normally (no server, non-Jellyfin,
    // cache disabled/unavailable, or first sync already persisted complete).
    | { reason: string; show: 'app' }
    // Block the app behind the dashboard until the first full sync completes.
    | { show: 'dashboard' };

/**
 * True when the gate released purely because every entity is currently `full`
 * (the LIVE signal) and no durable flag has been persisted yet. The caller
 * persists `firstSyncComplete` on this so a later background re-sync — which
 * briefly flips an entity back to `partial` — can't re-block the app and flap
 * the wizard into view. Once persisted, the verdict is `persisted-complete` and
 * this returns false.
 */
export const isLiveCompleteVerdict = (verdict: GateVerdict): boolean =>
    verdict.show === 'app' && verdict.reason === 'live-complete';

const isEntityEnabled = (toggles: GateEntityToggles, entity: GateEntity): boolean => {
    if (!toggles) return true;
    return toggles[entity] !== false;
};

/**
 * The list of enabled gate entities for the current settings.
 */
export const enabledGateEntities = (toggles: GateEntityToggles): GateEntity[] =>
    GATE_ENTITIES.filter((e) => isEntityEnabled(toggles, e));

/**
 * True when every ENABLED gate entity has reached hydrationState `full`.
 * Disabled entities don't block. With no enabled entities at all the sync is
 * trivially complete (nothing to sync).
 */
export const isFirstSyncComplete = (
    toggles: GateEntityToggles,
    hydrationStates: Partial<Record<string, HydrationState>>,
): boolean => {
    const entities = enabledGateEntities(toggles);
    if (entities.length === 0) return true;
    return entities.every((e) => hydrationStates[e] === 'full');
};

/**
 * THE gate decision. Returns whether to show the blocking dashboard or release
 * into the app, with a human-readable reason for the "app" verdicts (logged at
 * the call site so the gate's behaviour is traceable).
 */
export const computeGateState = (input: GateStateInput): GateVerdict => {
    const { cacheAvailable, enabled, entityToggles, hydrationStates, persistedComplete, server } =
        input;

    // Cache must be enabled + available for the gate to apply at all.
    if (!enabled) return { reason: 'cache-disabled', show: 'app' };
    if (cacheAvailable === false) return { reason: 'cache-unavailable', show: 'app' };

    // The gate only applies to a configured Jellyfin server with a userId
    // (the cache is per (serverId, userId)). Anything else passes through.
    if (!server) return { reason: 'no-server', show: 'app' };
    if (server.type !== 'jellyfin') return { reason: 'non-jellyfin', show: 'app' };
    if (!server.userId) return { reason: 'no-user-id', show: 'app' };

    // Already released for this server (full or via the escape hatch) — never
    // re-block, even if a later background re-sync briefly drops an entity out
    // of `full`. Forced re-sync on launch is keyed off the persisted flag NOT
    // being set, so an interrupted first sync (flag never written) re-enters
    // the dashboard; a completed one stays released.
    if (persistedComplete) return { reason: 'persisted-complete', show: 'app' };

    // No persisted completion yet → gate on live hydration states.
    if (isFirstSyncComplete(entityToggles, hydrationStates)) {
        return { reason: 'live-complete', show: 'app' };
    }

    return { show: 'dashboard' };
};
