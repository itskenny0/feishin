import { useEffect } from 'react';

import type { EntityType } from './types';

import { reconcileVolumeHealth } from './backends/active-backend';
import { isCacheAvailable } from './capability';
import {
    awaitActiveCacheDb,
    closeCacheDb,
    deleteCacheDb,
    getActiveCacheDb,
    getLastOpenError,
    type LibraryCacheDb,
    resetCacheDb,
    setActiveCacheDb,
} from './db';
import { estimateBytes, evict } from './eviction';
import { resolveThumbnail } from './images';
import { runIntegrityCheck } from './integrity';
import { startWorker } from './mutations';
import { refreshOfflineAvailability, refreshOfflineStats } from './offline-media';
import { offlineManager } from './offline/manager';
import { resetSearchIndexes } from './search';
import { clearAllSnapshots, dropSnapshotsForServer } from './snapshot';
import { useCacheActions, useCacheStore } from './store';
import { cancelHydration, hydrate } from './sync';

import { registerReachabilityProbe } from '/@/renderer/lib/network-status';
import { useAuthStore, useSettingsStore } from '/@/renderer/store';
import { registerThumbnailResolver } from '/@/shared/components/image/use-native-image';
import { toast } from '/@/shared/components/toast/toast';

// Per-session de-dup so the "Cache unavailable" toast fires once per
// (serverId, userId) rather than re-firing on every effect re-run.
let lastToastedErrorKey: string | undefined;

// Auto-reset a hard-broken DB at most once per (serverId, userId) per session so
// a failed schema upgrade self-heals instead of stranding the user on the manual
// "go reset in Settings" toast. A second failure for the same key falls through
// to the toast, so we never loop.
const autoResetAttempted = new Set<string>();

// Bridge the renderer-only thumbnail cache into the shared `useNativeImage`
// hook. Registered eagerly at module load so even the first `<ItemImage>`
// mount during boot has a chance to hit Dexie.
registerThumbnailResolver(resolveThumbnail);

// Self-healing reachability probe for the offline latch (see
// network-status.markServerUnreachable). When a streak of image timeouts (or an
// axios transport error) latches the combined signal "offline", every cache
// sweep parks and stops issuing requests — so nothing would ever clear the
// latch. This probe pings the current server's liveness endpoint on an interval
// while latched and clears it on the first response. ANY HTTP response (even
// 401/404/500) proves reachability; only a transport throw means still-down.
// Registered here (not in network-status) so that leaf module stays free of
// api/auth imports. The closure reads the live currentServer each tick.
registerReachabilityProbe(async () => {
    const server = useAuthStore.getState().currentServer;
    if (!server?.url) return false;
    const base = server.url.replace(/\/+$/, '');
    const url = server.type === 'jellyfin' ? `${base}/System/Ping` : `${base}/rest/ping.view`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
        await fetch(url, { method: 'GET', signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
});

// One-shot cleanup flag, stored per-DB in the syncMeta table. NOT a real
// EntityType — cast at the two call sites below so the union stays honest
// everywhere else.
const MISS_PURGE_FLAG = 'thumbnailsMissPurge_v1';

/**
 * One-shot purge of FALSE negative-cache markers left by the old resolver.
 *
 * Background: against a load-shedding Jellyfin the resolver wrote ~46k hard
 * "no artwork" markers from SILENT 404s for covers that actually exist, each
 * with a flat 7-day TTL — so the UI showed placeholders for a week. The
 * soft-miss model (cache/sync/miss-ttl + the isServerStressed gate) fixes
 * FUTURE 404s, but the markers already on disk must be deleted so the next
 * sweep / lazy load re-fetches them under the new gate.
 *
 * Deliberately NOT a Dexie version migration (that would block DB-open and
 * risk a whole-store drop if it threw). Instead a syncMeta-flagged one-shot
 * that runs once per DB at lifecycle startup, in chunked SEPARATE
 * transactions so it never stalls boot. Deletes ONLY pure negative markers
 * (MissAt set, zero bytes, no Blob/Path) — a successful cover write clears
 * MissAt, so no real cover carries a live MissAt and nothing real is at risk.
 */
const runThumbnailMissPurgeOnce = async (db: LibraryCacheDb): Promise<void> => {
    try {
        const already = await db.syncMeta.get(MISS_PURGE_FLAG as EntityType);
        if (already) return;
        // Collect candidate keys via the MissAt index (skips the row store /
        // blobs entirely), then read the small marker rows in chunks to verify
        // each is a PURE negative marker before deleting.
        const candidateKeys = (await db.thumbnails.where('MissAt').above(0).primaryKeys()) as [
            string,
            string,
        ][];
        let deleted = 0;
        const CHUNK = 500;
        // The boot sequence re-opens the SAME-server DB (a fresh Dexie instance
        // with the same name), so an identity check (db !== getActiveCacheDb())
        // aborts the purge after a single chunk once the re-open lands during a
        // yield. Key on the db NAME instead: re-fetch the active instance each
        // chunk and bail only on a genuine server switch (name change) or a
        // closed DB.
        const targetName = db.name;
        for (let i = 0; i < candidateKeys.length; i += CHUNK) {
            const active = getActiveCacheDb();
            if (!active || active.name !== targetName) return;
            const slice = candidateKeys.slice(i, i + CHUNK);
            const rows = await active.thumbnails.bulkGet(slice);
            const toDelete: [string, string][] = [];
            for (let j = 0; j < rows.length; j += 1) {
                const r = rows[j];
                // Pure negative marker only: MissAt set, no bytes, no blob, no
                // file path. (A real cover never carries a live MissAt.)
                if (r && (r.MissAt ?? 0) > 0 && r.ByteSize === 0 && !r.Blob && !r.Path) {
                    toDelete.push(slice[j]);
                }
            }
            if (toDelete.length > 0) {
                await active.thumbnails.bulkDelete(toDelete);
                deleted += toDelete.length;
            }
            // Yield between chunks so the purge never monopolises the single
            // IndexedDB worker / main thread during boot.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const finalDb = getActiveCacheDb();
        if (!finalDb || finalDb.name !== targetName) return;
        console.info('[cache] thumbnail miss-purge: cleared false 404 markers', {
            candidates: candidateKeys.length,
            deleted,
        });
        // Set the flag last so a crash mid-purge re-runs the (idempotent) pass.
        await finalDb.syncMeta.put({
            EntityType: MISS_PURGE_FLAG as EntityType,
            hydrationState: 'none',
            lastFullSyncAt: undefined,
            lastSweepAt: undefined,
            nextStartIndex: undefined,
            pausedUntil: undefined,
            totalCount: undefined,
        });
    } catch (err) {
        console.warn('[cache] thumbnail miss-purge failed', err);
    }
};

/**
 * Mount-once renderer hook that wires the Dexie-backed cache to the
 * current auth-store server. It performs four jobs, one per effect:
 *
 *  1. Probes IndexedDB capability once at startup and writes the result
 *     into `useCacheStore.cacheAvailable`.
 *  2. On `currentServer` changes, opens the matching `(serverId, userId)`
 *     Dexie DB, updates `useCacheStore.activeServer`, kicks the mutation
 *     queue worker so any queued writes drain on cold start, and seeds the
 *     dashboard's bytes-used readout with a best-effort eviction pass.
 *  3. On `currentServer` changes, checks whether any fully-hydrated entity
 *     is more than 24 hours stale and, if so, triggers a fresh full
 *     hydration automatically.
 *  4. Subscribes to the `feishin:server-deleted` window event so the
 *     matching Dexie DB is dropped when the user removes a server.
 *
 * All four effects short-circuit when `localCache.enabled !== true` so the
 * subsystem stays inert until the user opts in via the first-launch modal
 * or the dashboard master toggle. Flipping the toggle off cleanly closes
 * the active DB; flipping it back on re-runs every effect because `enabled`
 * is in their dep arrays.
 */
export const useCacheLifecycle = (): void => {
    const currentServer = useAuthStore((s) => s.currentServer);
    const enabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const actions = useCacheActions();

    // Job 0 — wire the offline-download manager's post-change hook to a stats
    // refresh so a settled/removed target updates the aggregate + availability
    // immediately. Done at runtime (not module load) to avoid a circular-import
    // TDZ, and without the manager statically importing the stats module.
    useEffect(() => {
        offlineManager.setOnChanged(() => refreshOfflineStats());
    }, []);

    // Job 1 — capability probe (runs once on first mount).
    useEffect(() => {
        if (!enabled) {
            console.info('[cache] lifecycle: subsystem disabled (enabled !== true)');
            actions.setCacheAvailable(false);
            return;
        }
        let cancelled = false;
        console.info('[cache] lifecycle: probing IndexedDB');
        isCacheAvailable()
            .then((available) => {
                if (cancelled) return;
                console.info('[cache] lifecycle: capability', { available });
                actions.setCacheAvailable(available);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn('[cache] lifecycle: capability probe failed', err);
                actions.setCacheAvailable(false);
            });
        return () => {
            cancelled = true;
        };
    }, [actions, enabled]);

    // Job 1b — Android storage-volume health. Re-enumerates volumes and pushes
    // the active backend's availability into the store on mount and whenever
    // the app returns to the foreground, so a removed/reinserted SD card flips
    // the offline-availability gate + banner. No-op on the idb backend (always
    // available), so non-Android platforms pay one cheap call.
    useEffect(() => {
        if (!enabled) return;
        void reconcileVolumeHealth();
        const onVisible = (): void => {
            if (document.visibilityState === 'visible') void reconcileVolumeHealth();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [enabled]);

    // Job 2 — open/close DB on currentServer change.
    useEffect(() => {
        if (!enabled) {
            // Read the previously-active server straight from the auth store
            // so that signing-out-then-disabling still finds the right Dexie
            // DB to close. Using React closure here would miss the case where
            // the user signed out between renders (Bug 8).
            const prevServer = useAuthStore.getState().currentServer;
            console.info('[cache] lifecycle: subsystem disabled (enabled !== true)', {
                hadPrevServer: Boolean(prevServer),
            });
            // Cancel any in-flight hydration sweep BEFORE closing the DB so
            // the sweep doesn't keep writing to a closed handle (Bug 2).
            cancelHydration('subsystem disabled');
            // Wipe in-memory caches so a re-enable starts fresh and we don't
            // replay stale snapshot/search data from before the toggle.
            clearAllSnapshots();
            resetSearchIndexes();
            actions.setActiveServer(undefined);
            if (prevServer?.type === 'jellyfin' && prevServer.userId) {
                void closeCacheDb(prevServer.id, prevServer.userId).catch((err) =>
                    console.warn('[cache] lifecycle: closeCacheDb on disable failed', err),
                );
            }
            return;
        }
        // Jellyfin-only. For non-Jellyfin servers (or no server) the
        // cache stays inactive.
        if (!currentServer || currentServer.type !== 'jellyfin') {
            actions.setActiveServer(undefined);
            console.info('[cache] lifecycle: no jellyfin server active');
            return;
        }
        const { id: serverId, userId } = currentServer;
        if (!userId) {
            console.warn(
                '[cache] lifecycle: current jellyfin server has no userId; cache inactive',
            );
            actions.setActiveServer(undefined);
            return;
        }

        let cancelled = false;
        console.info('[cache] lifecycle: opening db', { serverId, userId });
        setActiveCacheDb(serverId, userId)
            .then(async (db) => {
                if (cancelled) return;
                if (!db) {
                    console.warn('[cache] lifecycle: db unavailable for', { serverId, userId });
                    actions.setActiveServer(undefined);
                    // If the open failed because a schema upgrade or IndexedDB-
                    // level fault tripped, try to self-heal ONCE: wipe the broken
                    // DB and re-open clean (the SyncGate then re-blocks and re-
                    // syncs). Only if that fails too do we fall back to the manual
                    // "go reset in Settings" toast.
                    const openErr = getLastOpenError();
                    const key = `${serverId}:${userId}`;
                    if (openErr && !autoResetAttempted.has(key)) {
                        autoResetAttempted.add(key);
                        console.warn('[integrity] open failed; auto-resetting once', { serverId });
                        try {
                            useSettingsStore.getState().actions.clearFirstSyncComplete(serverId);
                            await resetCacheDb(serverId, userId);
                            const fresh = await setActiveCacheDb(serverId, userId);
                            if (!fresh) throw new Error('reopen after auto-reset failed');
                            if (cancelled) return;
                            console.info('[integrity] auto-reset reopened clean DB', { serverId });
                            actions.setActiveServer({ serverId, userId });
                        } catch (err) {
                            console.warn('[integrity] auto-reset failed; manual toast', err);
                            if (lastToastedErrorKey !== key) {
                                lastToastedErrorKey = key;
                                toast.error({
                                    autoClose: 8000,
                                    message:
                                        'Local cache database is corrupted. Go to Settings → Library sync to reset it.',
                                    title: 'Cache unavailable',
                                });
                            }
                        }
                        return;
                    }
                    if (openErr && lastToastedErrorKey !== key) {
                        lastToastedErrorKey = key;
                        toast.error({
                            autoClose: 8000,
                            message:
                                'Local cache database is corrupted. Go to Settings → Library sync to reset it.',
                            title: 'Cache unavailable',
                        });
                    }
                    return;
                }
                console.info('[cache] lifecycle: db ready', { serverId, userId });
                // Integrity verification: detect cross-store drift / stale
                // syncMeta and heal (background re-sync) or hard-reset (re-gate)
                // BEFORE seeding counts. On a reset the runner wipes + re-opens
                // the DB and clears the first-sync flag, so the SyncGate re-blocks
                // and re-syncs — skip the rest of this activation (the old `db`
                // handle is now closed; the fresh sync repopulates).
                try {
                    const verdict = await runIntegrityCheck(db, currentServer);
                    if (cancelled) return;
                    if (verdict.action === 'reset') {
                        console.info('[cache] lifecycle: integrity reset complete', { serverId });
                        return;
                    }
                } catch (err) {
                    console.warn('[cache] lifecycle: integrity check failed', err);
                }
                // Bug 9 — only emit setActiveServer when the (serverId,userId)
                // pair actually changes; the cache store stores a fresh object
                // on every call and subscribers can't distinguish a cosmetic
                // re-emit from a true switch.
                const existing = useCacheStore.getState().activeServer;
                if (existing?.serverId !== serverId || existing?.userId !== userId) {
                    actions.setActiveServer({ serverId, userId });
                } else {
                    console.info('[cache] lifecycle: activeServer unchanged, skipping re-emit', {
                        serverId,
                        userId,
                    });
                }
                // Kick the mutation worker so any queued writes drain on
                // cold start.
                void startWorker();
                // Seed the dashboard's bytes-used readout once on activation.
                void estimateBytes()
                    .then((n) => actions.setBytesUsed(n))
                    .catch((err) => console.warn('[cache] estimateBytes failed', err));
                // Run an eviction pass on activation in case quotas changed
                // between sessions (best-effort, no-op when under cap).
                void evict();
                // Seed the offline-media aggregate stats + availability index
                // from Dexie so the settings panel, the download banner, and
                // the green "available offline" indicators reflect what's
                // already on disk immediately after a cold start.
                void refreshOfflineStats();
                void refreshOfflineAvailability();
                // Auto-resume any pending/interrupted offline downloads (queued
                // targets + crash residue) now that the DB is open.
                void offlineManager.resumePersisted();
                // One-shot: backfill db.songs metadata for downloads made before
                // metadata was persisted at download time, so the "Available
                // offline" view stops undercounting.
                void offlineManager.healSongMeta();
                // One-shot: clear the ~46k false 404 markers the old resolver
                // wrote against a load-shedding server, so the next sweep
                // re-fetches them under the new soft-miss + stress gate.
                // syncMeta-flagged → runs once per DB, never blocks boot.
                void runThumbnailMissPurgeOnce(db);
                // Restore the cache store from the persistent layer so the
                // dashboard shows accurate counts + hydration states after
                // a cold start. Both fields live in memory only; without
                // this step the user sees "0 / none" on every restart
                // even when Dexie has thousands of rows.
                void (async () => {
                    try {
                        // Count blob thumbnails via the MissAt index:
                        // miss rows have MissAt > 0 (indexed); blob
                        // rows have MissAt undefined (skipped by the
                        // index). totalRows - missRows = blobRows.
                        // Avoids the .filter().count() table scan,
                        // which loaded every Blob into memory on every
                        // server activation.
                        const [
                            albums,
                            artists,
                            songs,
                            playlists,
                            favorites,
                            genres,
                            totalThumbs,
                            missThumbs,
                        ] = await Promise.all([
                            db.albums.count(),
                            db.artists.count(),
                            db.songs.count(),
                            db.playlists.count(),
                            db.favorites.count(),
                            db.genres.count(),
                            db.thumbnails.count(),
                            db.thumbnails.where('MissAt').above(0).count(),
                        ]);
                        const thumbnails = totalThumbs - missThumbs;
                        actions.setEntityCount('albums', albums);
                        actions.setEntityCount('artists', artists);
                        actions.setEntityCount('songs', songs);
                        actions.setEntityCount('playlists', playlists);
                        actions.setEntityCount('favorites', favorites);
                        actions.setEntityCount('genres', genres);
                        actions.setEntityCount('thumbnails', thumbnails);
                        const metas = await db.syncMeta.toArray();
                        for (const meta of metas) {
                            // Skip non-entity one-shot flag rows (e.g. the
                            // miss-purge marker, the offline song-meta heal
                            // flag) — they aren't hydration state.
                            const et = meta.EntityType as string;
                            if (et === MISS_PURGE_FLAG || et === 'offlineSongMetaHeal_v1') continue;
                            actions.setHydrationState(meta.EntityType, meta.hydrationState);
                        }
                        console.info('[cache] lifecycle: restored counts + hydration', {
                            albums,
                            artists,
                            favorites,
                            genres,
                            playlists,
                            songs,
                            thumbnails,
                        });
                    } catch (err) {
                        console.warn('[cache] lifecycle: restore counts failed', err);
                    }
                })();
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn('[cache] lifecycle: db open failed', err);
                actions.setActiveServer(undefined);
            });

        // Capture `serverId` so the cleanup closure (running on the NEXT
        // render) can drop snapshots scoped to what was *previously* active.
        const previousServerId = serverId;
        return () => {
            cancelled = true;
            // Bug 3 — the in-flight hydration sweep was writing to the
            // previous server's DB. Cancel it before the next effect run
            // swaps the active DB to a different server.
            cancelHydration('lifecycle cleanup');
            // Bug 3 — drop the snapshot map entries for the previous server
            // so that server-A's query data never bleeds into server-B's
            // placeholderData reads on the next mount.
            dropSnapshotsForServer(previousServerId);
            console.info('[cache] lifecycle: cleanup for previous server', {
                previousServerId,
            });
            // We intentionally don't close on currentServer change — the
            // user may switch back. Closure on actual deleteServer is
            // handled by Job 5; closure on opt-out is handled by the
            // disabled branch above.
        };
    }, [actions, currentServer, enabled]);

    // Job 4 — daily auto-resync: if any fully-hydrated entity is more than
    // 24 hours stale, trigger a fresh full hydration once on mount.
    useEffect(() => {
        if (!enabled) {
            console.info('[cache] lifecycle: subsystem disabled (enabled !== true)');
            return;
        }
        if (!currentServer || currentServer.type !== 'jellyfin') return;

        let cancelled = false;
        void (async () => {
            try {
                // Await the DB so the daily auto-resync isn't silently skipped
                // by the boot race: at mount getActiveCacheDb() can be null
                // before the DB finishes opening, and this effect (deps:
                // [currentServer, enabled]) never re-runs to retry — so the
                // resync would never fire.
                const db = await awaitActiveCacheDb(15_000);
                if (!db || cancelled) return;
                const rows = await db.syncMeta.toArray();
                if (cancelled) return;
                const fullRows = rows.filter(
                    (r) => r.hydrationState === 'full' && (r.lastFullSyncAt ?? 0) > 0,
                );
                if (fullRows.length === 0) {
                    console.info(
                        '[cache] lifecycle: no full-hydrated entities; auto-resync skipped',
                    );
                    return;
                }
                const oldest = Math.min(...fullRows.map((r) => r.lastFullSyncAt ?? 0));
                const ageMs = Date.now() - oldest;
                const oneDayMs = 24 * 60 * 60 * 1000;
                // User can turn off the on-startup re-sync (WHAT is synced is
                // mandatory; only this automatic refresh is optional).
                const resyncOnStartup =
                    useSettingsStore.getState().localCache?.resyncOnStartup !== false;
                if (!resyncOnStartup) {
                    console.info('[cache] lifecycle: startup re-sync disabled by setting');
                } else {
                    if (ageMs > oneDayMs) {
                        console.info(
                            '[cache] lifecycle: oldest full sync stale, auto re-hydrating',
                            {
                                ageHours: Math.round(ageMs / (60 * 60 * 1000)),
                                oldestAt: oldest,
                            },
                        );
                        void hydrate(currentServer, 'full');
                    } else {
                        console.info('[cache] lifecycle: full sync still fresh', {
                            ageHours: Math.round(ageMs / (60 * 60 * 1000)),
                        });
                    }
                    // Piggyback the daily resync: pull any songs newly added to
                    // offline targets (playlist/album grew) since last launch.
                    void offlineManager.refreshTargets();
                }
            } catch (err) {
                console.warn('[cache] lifecycle: auto-resync check failed', err);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [currentServer, enabled]);

    // Job 5 — listen for the server-delete event.
    useEffect(() => {
        if (!enabled) {
            console.info('[cache] lifecycle: subsystem disabled (enabled !== true)');
            return;
        }
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ serverId: string; userId: string }>).detail;
            if (!detail?.serverId || !detail?.userId) return;
            console.info('[cache] lifecycle: server deleted, dropping db', detail);
            deleteCacheDb(detail.serverId, detail.userId).catch((err) =>
                console.warn('[cache] lifecycle: deleteCacheDb failed', err),
            );
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('feishin:server-deleted', handler);
            return () => window.removeEventListener('feishin:server-deleted', handler);
        }
        return undefined;
    }, [enabled]);

    // Job 6 — keep `bytesUsed` fresh. The dashboard reads
    // `useCacheStore.bytesUsed`, which is sourced from
    // `navigator.storage.estimate().usage` (i.e. total origin bytes). Before
    // this effect existed, that value was only refreshed on activation and
    // on eviction, so the user perceived the cache as "not filling up" even
    // while sweep was writing rows to IndexedDB. We now refresh on three
    // triggers:
    //  - any thumbnail write (the `feishin:thumbnail-written` event)
    //  - a periodic 15s tick while the cache is active
    //  - whenever the sweep state transitions (entity progressed / done)
    // All three coalesce through a single throttled writer so the cache
    // store doesn't tear under burst-write conditions.
    const activeServer = useCacheStore((s) => s.activeServer);
    useEffect(() => {
        if (!enabled) return;
        if (!activeServer) return;

        let cancelled = false;
        let pending = false;
        let lastAt = 0;
        const MIN_INTERVAL_MS = 2_000;

        const tick = async () => {
            if (cancelled) return;
            // While ANY sweep is running, skip the cache-size estimate: it does
            // an O(N) `db.thumbnails.orderBy('ByteSize').keys()` scan (see
            // eviction.estimateBytes) that grows with the table and serializes
            // on the single IndexedDB worker against the sweep's own writes —
            // the dominant cause of the sweep slowing to a crawl "after a few
            // thousand" items (worst in download mode, where every thumbnail
            // write fires `feishin:thumbnail-written` → this tick). The readout
            // refreshes when the sweep clears (the store subscription below
            // fires `tick()` on the sweep→undefined transition) and the
            // post-sweep eviction pass recomputes it. Mirrors the eviction
            // listener's own sweep gate (eviction.ts).
            if (useCacheStore.getState().sweep) return;
            const now = Date.now();
            if (now - lastAt < MIN_INTERVAL_MS) {
                if (!pending) {
                    pending = true;
                    setTimeout(
                        () => {
                            pending = false;
                            void tick();
                        },
                        MIN_INTERVAL_MS - (now - lastAt),
                    );
                }
                return;
            }
            lastAt = now;
            try {
                const n = await estimateBytes();
                if (!cancelled) actions.setBytesUsed(n);
            } catch (err) {
                console.warn('[cache] lifecycle: estimateBytes failed', err);
            }
        };

        const onThumb = () => void tick();
        const onSweep = () => void tick();
        const interval = setInterval(() => void tick(), 15_000);

        if (typeof window !== 'undefined') {
            window.addEventListener('feishin:thumbnail-written', onThumb);
            window.addEventListener('feishin:sweep-progress', onSweep);
        }

        // Also subscribe to the cache store's `sweep` field so progress
        // ticks update the readout even when the sweep itself doesn't
        // dispatch a window event.
        let lastSweep = useCacheStore.getState().sweep;
        const unsubscribe = useCacheStore.subscribe((state) => {
            if (state.sweep !== lastSweep) {
                lastSweep = state.sweep;
                void tick();
            }
        });

        // Kick a refresh now so the dashboard reflects whatever rows the
        // hydration sweep has already written by the time this effect runs.
        void tick();

        return () => {
            cancelled = true;
            clearInterval(interval);
            if (typeof window !== 'undefined') {
                window.removeEventListener('feishin:thumbnail-written', onThumb);
                window.removeEventListener('feishin:sweep-progress', onSweep);
            }
            unsubscribe();
        };
    }, [actions, activeServer, enabled]);
};
