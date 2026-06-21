import { describe, expect, it } from 'vitest';

import type { GateStateInput } from './gate-state';

import {
    computeGateState,
    enabledGateEntities,
    GATE_ENTITIES,
    isFirstSyncComplete,
    isLiveCompleteVerdict,
} from './gate-state';

const jellyfin = { id: 'srv1', type: 'jellyfin', userId: 'u1' };

const fullStates = Object.fromEntries(GATE_ENTITIES.map((e) => [e, 'full' as const]));

const base = (over: Partial<GateStateInput> = {}): GateStateInput => ({
    cacheAvailable: true,
    enabled: true,
    entityToggles: undefined,
    hydrationStates: {},
    persistedComplete: undefined,
    server: jellyfin,
    ...over,
});

describe('enabledGateEntities', () => {
    it('returns all entities when no toggles', () => {
        expect(enabledGateEntities(undefined)).toEqual([...GATE_ENTITIES]);
    });

    it('drops entities explicitly disabled', () => {
        expect(enabledGateEntities({ lyrics: false, playlists: false })).not.toContain('lyrics');
        expect(enabledGateEntities({ lyrics: false, playlists: false })).not.toContain('playlists');
    });

    it('keeps entities that are true or absent', () => {
        expect(enabledGateEntities({ albums: true })).toContain('albums');
    });
});

describe('isLiveCompleteVerdict', () => {
    // The gate must promote a LIVE completion (all entities full, no persisted
    // flag yet) into a durable persisted flag — otherwise a background re-sync
    // that flips an entity back to 'partial' re-blocks the app, flapping the
    // wizard into view repeatedly.
    it('is true for an app verdict reached via live-complete', () => {
        expect(isLiveCompleteVerdict({ reason: 'live-complete', show: 'app' })).toBe(true);
    });

    it('is false once the flag is already persisted', () => {
        expect(isLiveCompleteVerdict({ reason: 'persisted-complete', show: 'app' })).toBe(false);
    });

    it('is false for other app reasons (no server, cache disabled, …)', () => {
        expect(isLiveCompleteVerdict({ reason: 'no-server', show: 'app' })).toBe(false);
        expect(isLiveCompleteVerdict({ reason: 'cache-disabled', show: 'app' })).toBe(false);
    });

    it('is false while the dashboard is blocking', () => {
        expect(isLiveCompleteVerdict({ show: 'dashboard' })).toBe(false);
    });
});

describe('isFirstSyncComplete', () => {
    it('is false when no entity has hydrated', () => {
        expect(isFirstSyncComplete(undefined, {})).toBe(false);
    });

    it('is false when some enabled entities are not yet full', () => {
        expect(isFirstSyncComplete(undefined, { ...fullStates, songs: 'partial' })).toBe(false);
    });

    it('is true when every enabled entity is full', () => {
        expect(isFirstSyncComplete(undefined, fullStates)).toBe(true);
    });

    it('ignores disabled entities', () => {
        const states = { ...fullStates };
        delete (states as Record<string, unknown>).lyrics;
        // lyrics never hydrated, but it's disabled → still complete
        expect(isFirstSyncComplete({ lyrics: false }, states)).toBe(true);
    });

    it('is true (nothing to sync) when all entities disabled', () => {
        const toggles = Object.fromEntries(GATE_ENTITIES.map((e) => [e, false]));
        expect(isFirstSyncComplete(toggles, {})).toBe(true);
    });
});

describe('computeGateState', () => {
    it('shows the app when the cache is disabled', () => {
        const v = computeGateState(base({ enabled: false }));
        expect(v.show).toBe('app');
    });

    it('shows the app when the cache subsystem is unavailable', () => {
        expect(computeGateState(base({ cacheAvailable: false })).show).toBe('app');
    });

    it('shows the app when there is no server', () => {
        expect(computeGateState(base({ server: null })).show).toBe('app');
    });

    it('shows the app for non-jellyfin servers', () => {
        expect(
            computeGateState(base({ server: { id: 's', type: 'navidrome', userId: 'u' } })).show,
        ).toBe('app');
    });

    it('shows the app for a jellyfin server with no userId', () => {
        expect(computeGateState(base({ server: { id: 's', type: 'jellyfin' } })).show).toBe('app');
    });

    it('blocks with the dashboard before the first sync completes', () => {
        expect(computeGateState(base({ hydrationStates: {} })).show).toBe('dashboard');
    });

    it('releases into the app once every enabled entity is full', () => {
        const v = computeGateState(base({ hydrationStates: fullStates }));
        expect(v.show).toBe('app');
        expect(v).toMatchObject({ reason: 'live-complete' });
    });

    it('respects a persisted completion flag even if a live entity regresses', () => {
        const v = computeGateState(
            base({
                hydrationStates: { ...fullStates, songs: 'partial' },
                persistedComplete: { at: Date.now(), partial: false },
            }),
        );
        expect(v.show).toBe('app');
        expect(v).toMatchObject({ reason: 'persisted-complete' });
    });

    it('respects a partial (escape-hatch) persisted completion', () => {
        const v = computeGateState(
            base({ hydrationStates: {}, persistedComplete: { at: 1, partial: true } }),
        );
        expect(v.show).toBe('app');
    });
});
