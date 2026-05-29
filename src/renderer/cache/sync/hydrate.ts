import type { ServerListItem } from '/@/shared/types/domain-types';

import type { EntityType } from '../types';

import { getActiveCacheDb } from '../db';
import { useCacheStore } from '../store';
import { runAlbumsSweep } from './albums';
import { runArtistsSweep } from './artists';
import { runFavoritesSweep } from './favorites';
import { runGenresSweep } from './genres';
import { startSyncHeartbeat, stopSyncHeartbeat } from './heartbeat';
import { runPlaylistsSweep } from './playlists';
import { runSongsSweep } from './songs';
import { runThumbnailsSweep } from './thumbnails';

import { useAuthStore, useSettingsStore } from '/@/renderer/store';

// Per-entity opt-out flags. Default to ON when the settings slice predates
// the toggle UI so existing installs behave identically.
type EntityKey = 'albums' | 'artists' | 'favorites' | 'genres' | 'playlists' | 'songs';
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
        if (entityEnabled('artists')) {
            await runArtistsSweep({ db, entity: 'artists', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'artists' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping artists (disabled in settings)');
        }

        // Genres are tiny and live between artists and albums so the filter
        // panels (which depend on them) are warm before the heavier sweeps
        // dominate the network.
        if (entityEnabled('genres')) {
            await runGenresSweep({ db, entity: 'genres', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'genres' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping genres (disabled in settings)');
        }

        if (entityEnabled('albums')) {
            await runAlbumsSweep({ db, entity: 'albums', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'albums' });
                return;
            }
        } else {
            console.info('[cache] hydrate: skipping albums (disabled in settings)');
        }

        if (entityEnabled('playlists')) {
            await runPlaylistsSweep({ db, entity: 'playlists', signal }, server);
            if (signal.aborted) {
                console.warn('[cache] hydrate: aborted between steps', { after: 'playlists' });
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

        // Thumbnail pre-cache always runs last, after every entity has
        // been written to Dexie — the sweep walks the same tables. The
        // sweep is itself opt-in via `localCache.thumbnailSizes`; with no
        // sizes selected it's a near-zero-cost no-op.
        await runThumbnailsSweep({ signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'thumbnails' });
            return;
        }
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            console.warn('[cache] hydrate: aborted', { serverId: server.id });
            return;
        }
        console.warn('[cache] hydrate: failed', { error: err, serverId: server.id });
        throw err;
    } finally {
        stopSyncHeartbeat(`full/${server.id}`);
    }

    console.info('[cache] hydrate: full hydration complete', {
        durationMs: Date.now() - hydrateStartedAt,
        entityCounts: useCacheStore.getState().entityCounts,
        serverId: server.id,
    });
};

export const cancelHydration = (): void => {
    if (currentController) {
        currentController.abort();
        currentController = undefined;
    }
    useCacheStore.getState().actions.setSweep(undefined);
    console.warn('[cache] hydrate: cancelled by user');
};
