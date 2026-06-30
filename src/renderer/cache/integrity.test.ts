import 'fake-indexeddb/auto';

import type { ServerListItem } from '/@/shared/types/domain-types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrityInput } from './integrity';

import { openCacheDb, resetCacheDb } from './db';
import { computeIntegrityVerdict, runIntegrityCheck } from './integrity';

import { useSettingsStore } from '/@/renderer/store';

// hydrate is fired-and-forgotten by the heal branch; stub it so the test stays
// offline. Only integrity.ts pulls from './sync' in this test graph.
vi.mock('./sync', () => ({ hydrate: vi.fn(async () => undefined) }));

const STAMP = { appVersion: '1.0.0', fsBackendVersion: 3, schemaVersion: 12 };
const ALL = [
    'artists',
    'genres',
    'albums',
    'songs',
    'lyrics',
    'playlists',
    'favorites',
    'thumbnails',
] as const;

const base = (over: Partial<IntegrityInput> = {}): IntegrityInput => ({
    coreCounts: { albums: 100, songs: 1000 },
    current: STAMP,
    enabled: true,
    enabledEntities: [...ALL],
    entityCounts: Object.fromEntries(ALL.map((e) => [e, 10])),
    entityFull: Object.fromEntries(ALL.map((e) => [e, true])),
    lastSeen: STAMP,
    openFailed: false,
    persistedComplete: { at: 1, partial: false },
    ...over,
});

describe('computeIntegrityVerdict', () => {
    it('returns ok for a consistent populated DB', () => {
        expect(computeIntegrityVerdict(base()).action).toBe('ok');
    });

    it('I0: open failure forces reset', () => {
        expect(computeIntegrityVerdict(base({ openFailed: true })).action).toBe('reset');
    });

    it('I1: firstSyncComplete set but core tables empty -> reset', () => {
        const v = computeIntegrityVerdict(base({ coreCounts: { albums: 0, songs: 0 } }));
        expect(v.action).toBe('reset');
        expect(v.reasons.join(' ')).toMatch(/flag/i);
    });

    it('I1: no flag + empty core -> not reset (fresh install mid-sync)', () => {
        const v = computeIntegrityVerdict(
            base({
                coreCounts: { albums: 0, songs: 0 },
                entityFull: {},
                persistedComplete: undefined,
            }),
        );
        expect(v.action).not.toBe('reset');
    });

    it('I2: one entity full but zero rows -> heal that entity (deep pass)', () => {
        // Non-core entity only inspected in the deep pass -> lastSeen undefined.
        const counts = { ...base().entityCounts, lyrics: 0 };
        const v = computeIntegrityVerdict(base({ entityCounts: counts, lastSeen: undefined }));
        expect(v.action).toBe('heal');
        expect(v.healEntities).toEqual(['lyrics']);
    });

    it('escalates heal -> reset when >= half the entities are broken', () => {
        // 4 broken of 8 enabled hits ceil(8/2) = 4. Keep core non-empty so I1
        // does not pre-empt with its own reset; deep pass (lastSeen undefined)
        // so the non-core entities are inspected.
        const counts = {
            ...base().entityCounts,
            artists: 0,
            genres: 0,
            lyrics: 0,
            playlists: 0,
        };
        const v = computeIntegrityVerdict(base({ entityCounts: counts, lastSeen: undefined }));
        expect(v.action).toBe('reset');
        expect(v.reasons.join(' ')).toMatch(/escalate/);
    });

    it('I3: missing baseline on a consistent populated DB -> ok (adopt, no wipe)', () => {
        const v = computeIntegrityVerdict(base({ lastSeen: undefined }));
        expect(v.action).toBe('ok');
        expect(v.runDeep).toBe(true);
    });

    it('runDeep true when any stamp field changed', () => {
        expect(
            computeIntegrityVerdict(base({ lastSeen: { ...STAMP, schemaVersion: 11 } })).runDeep,
        ).toBe(true);
        expect(computeIntegrityVerdict(base()).runDeep).toBe(false);
    });

    it('fast path: only core entities inspected when stamps match', () => {
        // lyrics is broken but stamps are equal -> runDeep false -> the
        // non-core lyrics is not inspected, so the verdict stays ok.
        const counts = { ...base().entityCounts, lyrics: 0 };
        const v = computeIntegrityVerdict(base({ entityCounts: counts }));
        expect(v.runDeep).toBe(false);
        expect(v.action).toBe('ok');
    });

    it('disabled cache -> ok no-op', () => {
        expect(computeIntegrityVerdict(base({ enabled: false })).action).toBe('ok');
    });
});

describe('runIntegrityCheck (side effects)', () => {
    const server = { id: 'srv', type: 'jellyfin', userId: 'user' } as unknown as ServerListItem;

    beforeEach(async () => {
        await resetCacheDb(server.id, server.userId as string);
        const actions = useSettingsStore.getState().actions;
        actions.clearFirstSyncComplete(server.id);
        // enabled cache + a cleared integrity baseline so runDeep is always true
        // in these runner tests (so non-core entities are inspected).
        actions.setLocalCache({ enabled: true, integrity: {} });
        vi.clearAllMocks();
    });

    it('heal: demotes a stale-full entity, kicks hydrate, keeps the flag', async () => {
        const db = await openCacheDb(server.id, server.userId as string);
        if (!db) throw new Error('db did not open');
        await db.albums.bulkPut([{ Id: 'a1' } as never]);
        await db.songs.bulkPut([{ Id: 's1' } as never]);
        await db.syncMeta.put({ EntityType: 'lyrics', hydrationState: 'full' } as never);
        useSettingsStore.getState().actions.setFirstSyncComplete(server.id, false);

        const { hydrate } = await import('./sync');
        const verdict = await runIntegrityCheck(db, server);

        expect(verdict.action).toBe('heal');
        expect((await db.syncMeta.get('lyrics'))?.hydrationState).toBe('none');
        expect(hydrate).toHaveBeenCalled();
        expect(useSettingsStore.getState().localCache.firstSyncComplete?.[server.id]).toBeDefined();
    });

    it('reset: clears the flag when the flag lies about an empty DB', async () => {
        const db = await openCacheDb(server.id, server.userId as string);
        if (!db) throw new Error('db did not open');
        // core tables intentionally empty -> I1 reset.
        useSettingsStore.getState().actions.setFirstSyncComplete(server.id, false);

        const verdict = await runIntegrityCheck(db, server);

        expect(verdict.action).toBe('reset');
        expect(
            useSettingsStore.getState().localCache.firstSyncComplete?.[server.id],
        ).toBeUndefined();
    });

    it('ok: writes the version stamp', async () => {
        const db = await openCacheDb(server.id, server.userId as string);
        if (!db) throw new Error('db did not open');
        await db.albums.bulkPut([{ Id: 'a1' } as never]);
        await db.songs.bulkPut([{ Id: 's1' } as never]);
        useSettingsStore.getState().actions.setFirstSyncComplete(server.id, false);

        const verdict = await runIntegrityCheck(db, server);

        expect(verdict.action).toBe('ok');
        expect(useSettingsStore.getState().localCache.integrity?.lastSeen).toBeDefined();
    });
});
