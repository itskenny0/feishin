import { useEffect } from 'react';

import { isCacheAvailable } from './capability';
import { closeCacheDb, deleteCacheDb, getActiveCacheDb, setActiveCacheDb } from './db';
import { estimateBytes, evict } from './eviction';
import { resolveThumbnail } from './images';
import { startWorker } from './mutations';
import { resetSearchIndexes } from './search';
import { clearAllSnapshots, dropSnapshotsForServer } from './snapshot';
import { useCacheActions, useCacheStore } from './store';
import { cancelHydration, hydrate } from './sync';

import { useAuthStore, useSettingsStore } from '/@/renderer/store';
import { registerThumbnailResolver } from '/@/shared/components/image/use-native-image';

// Bridge the renderer-only thumbnail cache into the shared `useNativeImage`
// hook. Registered eagerly at module load so even the first `<ItemImage>`
// mount during boot has a chance to hit Dexie.
registerThumbnailResolver(resolveThumbnail);

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

    // Job 1 — capability probe (runs once on first mount).
    useEffect(() => {
        if (!enabled) {
            console.info('[cache] lifecycle: subsystem disabled (enabled !== true)');
            actions.setCacheAvailable(false);
            return;
        }
        let cancelled = false;
        console.info('[cache] lifecycle: probing IndexedDB');
        isCacheAvailable().then((available) => {
            if (cancelled) return;
            console.info('[cache] lifecycle: capability', { available });
            actions.setCacheAvailable(available);
        });
        return () => {
            cancelled = true;
        };
    }, [actions, enabled]);

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
            cancelHydration();
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
            .then((db) => {
                if (cancelled) return;
                if (!db) {
                    console.warn('[cache] lifecycle: db unavailable for', { serverId, userId });
                    actions.setActiveServer(undefined);
                    return;
                }
                console.info('[cache] lifecycle: db ready', { serverId, userId });
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
                void estimateBytes().then((n) => actions.setBytesUsed(n));
                // Run an eviction pass on activation in case quotas changed
                // between sessions (best-effort, no-op when under cap).
                void evict();
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
            cancelHydration();
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
        const db = getActiveCacheDb();
        if (!db) return;

        let cancelled = false;
        void (async () => {
            try {
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
                if (ageMs > oneDayMs) {
                    console.info('[cache] lifecycle: oldest full sync stale, auto re-hydrating', {
                        ageHours: Math.round(ageMs / (60 * 60 * 1000)),
                        oldestAt: oldest,
                    });
                    void hydrate(currentServer, 'full');
                } else {
                    console.info('[cache] lifecycle: full sync still fresh', {
                        ageHours: Math.round(ageMs / (60 * 60 * 1000)),
                    });
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
