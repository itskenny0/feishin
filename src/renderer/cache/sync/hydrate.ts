import type { ServerListItem } from '/@/shared/types/domain-types';

import type { EntityType } from '../types';

import { getActiveCacheDb } from '../db';
import { useCacheStore } from '../store';
import { applyThumbnailPreset, autoSelectPreset, detectThumbnailPreset } from '../variant-config';
import { runAlbumsSweep } from './albums';
import { runArtistsSweep } from './artists';
import { runFavoritesSweep } from './favorites';
import { runGenresSweep } from './genres';
import { startSyncHeartbeat, stopSyncHeartbeat } from './heartbeat';
import { runLyricsSweep } from './lyrics';
import { runPlaylistSongsSweep, runPlaylistsSweep } from './playlists';
import { runSongsSweep } from './songs';
import { runThumbnailsSweep } from './thumbnails';

import { DEFAULT_IMAGE_VARIANTS, useAuthStore, useSettingsStore } from '/@/renderer/store';

// Per-entity opt-out flags. Default to ON when the settings slice predates
// the toggle UI so existing installs behave identically.
type EntityKey = 'albums' | 'artists' | 'favorites' | 'genres' | 'lyrics' | 'playlists' | 'songs';
const entityEnabled = (kind: EntityKey): boolean => {
    const e = useSettingsStore.getState().localCache?.entities;
    if (!e) return true;
    return e[kind] !== false;
};

// Module-level controller so a second hydrate() call can cancel the
// previous in-flight run before starting fresh.
let currentController: AbortController | undefined;

const LAZY_ENTITIES: EntityType[] = [
    'artists',
    'genres',
    'albums',
    'songs',
    'playlists',
    'favorites',
];

export const hydrate = async (server: ServerListItem, kind: 'full' | 'lazy'): Promise<void> => {
    // Re-entrancy: abort any prior run before starting a new one.
    if (currentController) {
        currentController.abort();
    }
    const controller = new AbortController();
    currentController = controller;
    const { signal } = controller;

    const db = getActiveCacheDb();
    if (!db) {
        console.info('[cache] hydrate skipped: no active db', { kind, serverId: server.id });
        return;
    }

    // Server-id gating: if the active auth server no longer matches the
    // one we were asked to hydrate, bail before issuing any network
    // calls. Two rapid `currentServer` flips (A → B → A) could otherwise
    // dispatch a stale `hydrate(A)` after the lifecycle has reopened B,
    // and the sweep would write A's items into B's Dexie DB via the
    // briefly-stale `db` reference. Re-reading the auth-store snapshot
    // here makes the start-of-sweep check race-free.
    const authServer = useAuthStore.getState().currentServer;
    if (!authServer || authServer.id !== server.id) {
        console.info('[cache] hydrate skipped: active server mismatch', {
            activeId: authServer?.id,
            kind,
            requestedId: server.id,
        });
        return;
    }

    const actions = useCacheStore.getState().actions;

    if (kind === 'lazy') {
        for (const entity of LAZY_ENTITIES) {
            await db.syncMeta.put({
                EntityType: entity,
                hydrationState: 'lazy',
                lastFullSyncAt: undefined,
                lastSweepAt: undefined,
                nextStartIndex: 0,
                pausedUntil: undefined,
                totalCount: undefined,
            });
            actions.setHydrationState(entity, 'lazy');
        }
        console.info('[cache] hydrate: lazy mode set for all entities', {
            serverId: server.id,
        });
        return;
    }

    console.info('[cache] hydrate: starting full hydration', {
        kind,
        serverId: server.id,
    });

    const hydrateStartedAt = Date.now();
    startSyncHeartbeat(`full/${server.id}`);

    try {
        // Albums first: the home grid + album list are the most-visible
        // surfaces, so syncing them ahead of the slower artists sweep (2 RTT per
        // page) lets the user see their library soonest.
        if (entityEnabled('albums')) {
            await runAlbumsSweep({ db, entity: 'albums', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'albums' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping albums (disabled in settings)');
        }

        // Genres are tiny; sync them next so the album/song filter panels (which
        // depend on them) are warm right after the albums grid appears.
        if (entityEnabled('genres')) {
            await runGenresSweep({ db, entity: 'genres', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'genres' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping genres (disabled in settings)');
        }

        if (entityEnabled('artists')) {
            await runArtistsSweep({ db, entity: 'artists', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'artists' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping artists (disabled in settings)');
        }

        if (entityEnabled('playlists')) {
            await runPlaylistsSweep({ db, entity: 'playlists', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'playlists' });
                return;
            }
            // Track lists too — without them a "synced" playlist still hits
            // the network (and renders empty against a slow server) the
            // first time it's opened.
            await runPlaylistSongsSweep({ db, entity: 'playlists', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', {
                    after: 'playlist-songs',
                });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping playlists (disabled in settings)');
        }

        if (entityEnabled('favorites')) {
            await runFavoritesSweep({ db, entity: 'favorites', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'favorites' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping favorites (disabled in settings)');
        }

        if (entityEnabled('songs')) {
            await runSongsSweep({ db, entity: 'songs', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'songs' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping songs (disabled in settings)');
        }

        // Lyrics sweep runs AFTER songs — it walks the cached song rows to
        // fetch server/local lyrics into db.lyrics for offline use.
        if (entityEnabled('lyrics')) {
            await runLyricsSweep({ db, entity: 'lyrics', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'lyrics' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping lyrics (disabled in settings)');
        }

        // Auto-tune the thumbnail preset by device + library size BEFORE the
        // sweep reads its config — only when the user hasn't pinned a preset
        // (autoPreset). The metadata sweeps above have written every
        // thumbnail-bearing row, so the counts are accurate here.
        const autoIv = useSettingsStore.getState().localCache?.imageVariants;
        if (db && autoIv?.autoPreset) {
            const [albumN, artistN, playlistN] = await Promise.all([
                db.albums.count(),
                db.artists.count(),
                db.playlists.count(),
            ]);
            const itemCount = albumN + artistN + playlistN;
            const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0;
            const mem =
                typeof navigator !== 'undefined'
                    ? (navigator as { deviceMemory?: number }).deviceMemory
                    : undefined;
            const picked = autoSelectPreset(itemCount, cores, mem);
            console.info('[cache] auto-preset', { cores, itemCount, mem, picked });
            // Only write when it actually changes the enabled set (avoid store
            // churn); the full 3-way spread mirrors the settings patch helper so
            // sibling keys (mode/format/quality/autoPreset) survive the shallow
            // setLocalCache merge.
            if (detectThumbnailPreset(autoIv) !== picked) {
                useSettingsStore.getState().actions.setLocalCache({
                    imageVariants: {
                        ...DEFAULT_IMAGE_VARIANTS,
                        ...autoIv,
                        variants: applyThumbnailPreset(autoIv, picked),
                    },
                });
            }
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'auto-preset' });
                return;
            }
        }

        // Thumbnail pre-cache always runs last, after every entity has
        // been written to Dexie — the sweep walks the same tables. The
        // sweep is itself opt-in via `localCache.thumbnailSizes`; with no
        // sizes selected it's a near-zero-cost no-op.
        await runThumbnailsSweep({ signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'thumbnails' });
            return;
        }
        // The first-sync gate now WAITS on thumbnails (gate-state GATE_ENTITIES),
        // so mark the cover pass `full` once it completes — mirrors how each
        // metadata sweep persists its own state. Reached only on a clean finish
        // (an abort returns above), so an interrupted sweep leaves thumbnails
        // un-`full` and the gate retries. Persisted to syncMeta so a later boot's
        // gate seed knows the artwork pass already finished.
        await db.syncMeta.put({
            EntityType: 'thumbnails',
            hydrationState: 'full',
            lastFullSyncAt: Date.now(),
            lastSweepAt: Date.now(),
            nextStartIndex: 0,
            pausedUntil: undefined,
            totalCount: undefined,
        });
        actions.setHydrationState('thumbnails', 'full');
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            console.warn('[cache] hydrate: aborted', { serverId: server.id });
            return;
        }
        // Swallow rather than rethrow: every caller invokes this as
        // `void hydrate(...)` (lifecycle auto-resync, settings dashboard
        // buttons), so a rethrow only ever becomes an unhandled promise
        // rejection — noise that the renderer's boot-error overlay can treat
        // as a crash. The next scheduled/explicit hydration retries cleanly.
        console.warn('[cache] hydrate: failed', { error: err, serverId: server.id });
    } finally {
        stopSyncHeartbeat(`full/${server.id}`);
    }

    console.info('[cache] hydrate: full hydration complete', {
        durationMs: Date.now() - hydrateStartedAt,
        entityCounts: useCacheStore.getState().entityCounts,
        serverId: server.id,
    });
};

export const cancelHydration = (reason: string = 'user'): void => {
    // Only worth logging when a hydration was actually aborted — the cache
    // lifecycle calls this defensively from its effect cleanup on every
    // boot / server swap, and the unconditional "cancelled by user" warn
    // made routine launches look like repeated user cancellations.
    const hadInFlight = Boolean(currentController);
    if (currentController) {
        currentController.abort();
        currentController = undefined;
    }
    useCacheStore.getState().actions.setSweep(undefined);
    if (hadInFlight) {
        console.warn('[cache] hydrate: cancelled', { reason });
    }
};
