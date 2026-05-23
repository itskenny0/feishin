import type { ServerListItem } from '/@/shared/types/domain-types';

import type { EntityType } from '../types';

import { getActiveCacheDb } from '../db';
import { useCacheStore } from '../store';
import { runAlbumsSweep } from './albums';
import { runArtistsSweep } from './artists';
import { runFavoritesSweep } from './favorites';
import { runGenresSweep } from './genres';
import { runPlaylistsSweep } from './playlists';
import { runSongsSweep } from './songs';

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

    try {
        await runArtistsSweep({ db, entity: 'artists', signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'artists' });
            return;
        }

        // Genres are tiny and live between artists and albums so the filter
        // panels (which depend on them) are warm before the heavier sweeps
        // dominate the network.
        await runGenresSweep({ db, entity: 'genres', signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'genres' });
            return;
        }

        await runAlbumsSweep({ db, entity: 'albums', signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'albums' });
            return;
        }

        await runPlaylistsSweep({ db, entity: 'playlists', signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'playlists' });
            return;
        }

        await runFavoritesSweep({ db, entity: 'favorites', signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'favorites' });
            return;
        }

        await runSongsSweep({ db, entity: 'songs', signal }, server);
        if (signal.aborted) {
            console.warn('[cache] hydrate: aborted between steps', { after: 'songs' });
            return;
        }
    } catch (err) {
        if ((err as Error).name === 'AbortError') {
            console.warn('[cache] hydrate: aborted', { serverId: server.id });
            return;
        }
        console.warn('[cache] hydrate: failed', { error: err, serverId: server.id });
        throw err;
    }

    console.info('[cache] hydrate: full hydration complete', { serverId: server.id });
};

export const cancelHydration = (): void => {
    if (currentController) {
        currentController.abort();
        currentController = undefined;
    }
    useCacheStore.getState().actions.setSweep(undefined);
    console.warn('[cache] hydrate: cancelled by user');
};
