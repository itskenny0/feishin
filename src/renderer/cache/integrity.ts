// Local cache integrity verification & self-heal.
//
// Three independent persistence layers can drift apart across an app upgrade:
//   - the settings store (firstSyncComplete[serverId] — the durable "first sync
//     done → release the app" flag),
//   - the Dexie DB (the cached rows + per-entity syncMeta.hydrationState),
//   - the FS backend (cover bytes as native files, FS_BACKEND_VERSION).
// When one layer is wiped/migrated but another survives, the sync gate reads
// "complete" against an empty/stale DB and releases into a broken app — fixable
// today only by clearing ALL app data. This module verifies the layers agree on
// every DB activation and either heals (background re-sync of the broken
// entities, app stays open) or hard-resets (wipe + clear flag → the existing
// sync gate re-blocks and re-syncs from scratch).
//
// `computeIntegrityVerdict` is pure (no Dexie/settings access) so the decision
// is unit-testable directly; `runIntegrityCheck` gathers the facts and applies
// the side effects.

import type { ServerListItem } from '/@/shared/types/domain-types';

import packageJson from '../../../package.json';
import { FS_BACKEND_VERSION } from './backends/active-backend';
import { type LibraryCacheDb, resetCacheDb, setActiveCacheDb } from './db';
import { useCacheStore } from './store';
import { hydrate } from './sync';
import { enabledGateEntities, GATE_ENTITIES, type GateEntity } from './sync-gate/gate-state';

import { useSettingsStore } from '/@/renderer/store';

const TAG = '[integrity]';

export interface IntegrityInput {
    /** Row counts of the two core metadata tables. */
    coreCounts: { albums: number; songs: number };
    /** Current (appVersion, schemaVersion = db.verno, fsBackendVersion). */
    current: VersionStamp;
    /** localCache.enabled === true. */
    enabled: boolean;
    /** Enabled gate entities (from enabledGateEntities). */
    enabledEntities: GateEntity[];
    /** Per-entity table.count(). */
    entityCounts: Partial<Record<GateEntity, number>>;
    /** Per-entity syncMeta.hydrationState === 'full'. */
    entityFull: Partial<Record<GateEntity, boolean>>;
    /** settings.localCache.integrity?.lastSeen. */
    lastSeen: undefined | VersionStamp;
    /** openCacheDb failed for this server (getLastOpenError set). */
    openFailed: boolean;
    /** settings.localCache.firstSyncComplete[serverId]. */
    persistedComplete: undefined | { at: number; partial: boolean };
}

export interface IntegrityVerdict {
    action: 'heal' | 'ok' | 'reset';
    healEntities: GateEntity[];
    reasons: string[];
    /** Version stamp changed (or never seen) → run the full per-entity pass. */
    runDeep: boolean;
}

export interface VersionStamp {
    appVersion: string;
    fsBackendVersion: number;
    schemaVersion: number;
}

const stampsEqual = (a: undefined | VersionStamp, b: VersionStamp): boolean =>
    !!a &&
    a.appVersion === b.appVersion &&
    a.schemaVersion === b.schemaVersion &&
    a.fsBackendVersion === b.fsBackendVersion;

/**
 * Pure integrity verdict. Precedence: reset > heal > ok.
 *
 * I0 open failure ⇒ reset.
 * I1 firstSyncComplete set but BOTH core tables empty ⇒ reset (the durable
 *    "done" flag is lying about a wiped/foreign DB — the reported symptom).
 * I2 entity hydrationState 'full' but zero rows ⇒ heal that entity.
 * I3 missing baseline on a consistent populated DB ⇒ ok (adopt; NEVER wipe an
 *    existing install just because it predates this feature).
 * Escalation: heal ≥ ceil(enabled / 2) ⇒ reset.
 * runDeep: stamp changed ⇒ I2 over ALL enabled entities; else only core.
 */
export const computeIntegrityVerdict = (input: IntegrityInput): IntegrityVerdict => {
    const reasons: string[] = [];
    const runDeep = !stampsEqual(input.lastSeen, input.current);

    if (!input.enabled) {
        return { action: 'ok', healEntities: [], reasons: ['cache-disabled'], runDeep };
    }

    if (input.openFailed) {
        return { action: 'reset', healEntities: [], reasons: ['open-failed'], runDeep };
    }

    const coreEmpty = input.coreCounts.albums === 0 && input.coreCounts.songs === 0;

    // I1 — the workhorse cross-store check.
    if (input.persistedComplete && coreEmpty) {
        reasons.push('flag-set-but-core-empty');
        return { action: 'reset', healEntities: [], reasons, runDeep };
    }

    // I2 — syncMeta 'full' against an empty table. The fast path inspects only
    // the core tables; the deep path (stamp changed) inspects every enabled
    // entity.
    const toInspect: GateEntity[] = runDeep
        ? input.enabledEntities
        : input.enabledEntities.filter((e) => e === 'albums' || e === 'songs');

    const healEntities: GateEntity[] = [];
    for (const e of toInspect) {
        if (input.entityFull[e] === true && (input.entityCounts[e] ?? 0) === 0) {
            healEntities.push(e);
        }
    }

    if (healEntities.length > 0) {
        reasons.push(`stale-syncmeta:${healEntities.join(',')}`);
        const half = Math.ceil(input.enabledEntities.length / 2);
        if (healEntities.length >= half) {
            reasons.push('escalate-heal-to-reset');
            return { action: 'reset', healEntities, reasons, runDeep };
        }
        return { action: 'heal', healEntities, reasons, runDeep };
    }

    return { action: 'ok', healEntities: [], reasons: ['consistent'], runDeep };
};

const currentStamp = (db: LibraryCacheDb): VersionStamp => ({
    appVersion: packageJson.version,
    fsBackendVersion: FS_BACKEND_VERSION,
    schemaVersion: db.verno,
});

const tableFor = (db: LibraryCacheDb, e: GateEntity): { count: () => Promise<number> } =>
    (db as unknown as Record<string, { count: () => Promise<number> }>)[e];

/**
 * Gather the facts the verdict needs from Dexie + settings, compute the verdict,
 * and apply its side effects. Returns the verdict (for the caller's logging).
 * Runs on every DB activation; the heavy per-entity inspection only engages when
 * a version stamp changed (verdict.runDeep).
 */
export const runIntegrityCheck = async (
    db: LibraryCacheDb,
    server: ServerListItem,
): Promise<IntegrityVerdict> => {
    const settings = useSettingsStore.getState();
    const enabled = settings.localCache?.enabled === true;
    const toggles = settings.localCache?.entities;
    const enabledEntities = enabledGateEntities(toggles);
    const persistedComplete = settings.localCache?.firstSyncComplete?.[server.id];
    const lastSeen = settings.localCache?.integrity?.lastSeen;
    const current = currentStamp(db);

    const [albums, songs] = await Promise.all([db.albums.count(), db.songs.count()]);
    const metas = await db.syncMeta.toArray();
    const stateByEntity = new Map(metas.map((m) => [m.EntityType as string, m.hydrationState]));
    const entityCounts: Partial<Record<GateEntity, number>> = {};
    const entityFull: Partial<Record<GateEntity, boolean>> = {};
    for (const e of enabledEntities) {
        entityCounts[e] = await tableFor(db, e).count();
        entityFull[e] = stateByEntity.get(e) === 'full';
    }

    const verdict = computeIntegrityVerdict({
        coreCounts: { albums, songs },
        current,
        enabled,
        enabledEntities,
        entityCounts,
        entityFull,
        lastSeen,
        openFailed: false,
        persistedComplete,
    });

    console.info(`${TAG} verdict`, {
        action: verdict.action,
        current,
        healEntities: verdict.healEntities,
        lastSeen,
        reasons: verdict.reasons,
        runDeep: verdict.runDeep,
        serverId: server.id,
    });

    const cacheActions = useCacheStore.getState().actions;

    if (verdict.action === 'heal') {
        for (const e of verdict.healEntities) {
            const meta = metas.find((m) => (m.EntityType as string) === e);
            await db.syncMeta.put({
                EntityType: e,
                hydrationState: 'none',
                lastFullSyncAt: undefined,
                lastSweepAt: meta?.lastSweepAt,
                nextStartIndex: undefined,
                pausedUntil: undefined,
                totalCount: meta?.totalCount,
            });
            cacheActions.setHydrationState(e, 'none');
            console.info(`${TAG} healed (demoted) entity`, { entity: e, serverId: server.id });
        }
        // Background refill of the demoted entities; the flag stays set so the
        // gate does NOT re-block — the app stays open and lists/covers refill as
        // the sweep runs.
        if (server.type === 'jellyfin') {
            void hydrate(server, 'full').catch((err) =>
                console.warn(`${TAG} background hydrate after heal failed`, err),
            );
        }
        settings.actions.setIntegrityLastSeen(current);
        return verdict;
    }

    if (verdict.action === 'reset') {
        console.warn(`${TAG} hard reset`, { reasons: verdict.reasons, serverId: server.id });
        settings.actions.clearFirstSyncComplete(server.id);
        if (server.userId) {
            await resetCacheDb(server.id, server.userId);
            await setActiveCacheDb(server.id, server.userId);
        }
        for (const e of GATE_ENTITIES) cacheActions.setHydrationState(e, 'none');
        settings.actions.setIntegrityLastSeen(current);
        return verdict;
    }

    // ok — adopt / refresh the baseline.
    settings.actions.setIntegrityLastSeen(current);
    return verdict;
};
