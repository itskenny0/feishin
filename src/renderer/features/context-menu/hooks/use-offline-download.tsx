// use-offline-download — the single user-facing entry point for "Download for
// offline". Wraps the offline-media pipeline (cache/offline-media.ts) behind
// the feature gate (localCache.enabled + IndexedDB available) and surfaces a
// toast + lifecycle logging at the download-initiation boundary.
//
// Reused by both the context-menu action (right-click / long-press on any
// entity row or card) and the page-header offline icon. Never re-implements
// the download itself — it only marshals { entityType, entityId, name } and
// calls addAndSyncOfflineTarget().

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '/@/renderer/api';
import { enqueueOfflineMany } from '/@/renderer/cache/offline';
import { useCacheStore } from '/@/renderer/cache/store';
import { OfflineEntityType } from '/@/renderer/cache/types';
import { useCurrentServer } from '/@/renderer/store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';

const TAG = '[offline-media]';

/** An entity (or list of entities) the UI wants to download for offline. */
export interface OfflineDownloadEntity {
    entityType: OfflineEntityType;
    id: string;
    name: string;
}

/**
 * Map a LibraryItem to the offline pipeline's narrower OfflineEntityType.
 * Returns undefined for types the offline engine can't enumerate (folders,
 * queue songs). Album artists and artists both download as 'artist'.
 */
export const libraryItemToOfflineEntityType = (
    type: LibraryItem,
): OfflineEntityType | undefined => {
    switch (type) {
        case LibraryItem.ALBUM:
            return 'album';
        case LibraryItem.ALBUM_ARTIST:
        case LibraryItem.ARTIST:
            return 'artist';
        case LibraryItem.GENRE:
            return 'genre';
        case LibraryItem.PLAYLIST:
            return 'playlist';
        case LibraryItem.PLAYLIST_SONG:
        case LibraryItem.SONG:
            return 'song';
        default:
            return undefined;
    }
};

interface UseOfflineDownload {
    /**
     * Whether offline downloads are available right now: the local cache is
     * enabled, offline media isn't explicitly disabled, and IndexedDB is
     * present on this platform. Affordances should be hidden when false.
     */
    available: boolean;
    /** Download one or more entities for offline playback. */
    download: (entities: OfflineDownloadEntity[]) => Promise<void>;
}

export const useOfflineDownload = (): UseOfflineDownload => {
    const { t } = useTranslation();
    const server = useCurrentServer();

    // Gate: local cache enabled + IndexedDB present on this platform.
    const cacheEnabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const cacheAvailable = useCacheStore((s) => s.cacheAvailable);

    // `cacheAvailable === undefined` means capability hasn't been probed yet;
    // treat only an explicit `false` as unavailable so the affordance still
    // shows on a fresh load where the probe hasn't resolved.
    const available = cacheEnabled && cacheAvailable !== false;

    const download = useCallback(
        async (entities: OfflineDownloadEntity[]) => {
            if (!server?.id || entities.length === 0) return;

            const first = entities[0];
            const summary =
                entities.length === 1
                    ? first.name
                    : t('page.contextMenu.offlineDownloadCount', {
                          count: entities.length,
                          defaultValue: '{{count}} items',
                      });

            console.info(`${TAG} download initiated`, {
                count: entities.length,
                serverId: server.id,
                summary,
            });

            toast.info({
                message: t('page.contextMenu.offlineDownloadStarted', {
                    defaultValue: 'Downloading {{name}} for offline…',
                    name: summary,
                }),
            });

            // Enqueue all at once. Each becomes a queued target and downloads
            // sequentially — unlike the old per-item addAndSync, which aborted
            // the previous in-flight sync on every call, so a multi-select
            // "download all" cancelled everything but the last item.
            try {
                await enqueueOfflineMany(
                    entities.map((entity) => ({
                        entityId: entity.id,
                        entityType: entity.entityType,
                        name: entity.name,
                        serverId: server.id,
                    })),
                );
            } catch (err) {
                console.warn(`${TAG} download failed`, { err });
                toast.error({ message: (err as Error).message ?? String(err) });
            }
        },
        [server, t],
    );

    return { available, download };
};

// How many items a library-list "Download all" pulls when enumerating the
// current view. Bounded so the offline button on a 50k-track library doesn't
// try to mark every item.
const LIST_SOURCE_FETCH_LIMIT = 500;

/**
 * Build the list-page offline source. Lazily fetches the entities currently in
 * view (respecting the page's active filter/search `query`) on click and maps
 * each to an OfflineDownloadEntity. Used by library list pages
 * (Albums / Artists / Album-artists / Genres / Playlists / Songs).
 *
 * Returns `{ available, getEntities }` so the header can gate the button and
 * pass `getEntities` into LibraryHeaderBar.OfflineButton's `list` source.
 */
export const useOfflineListSource = (
    itemType: LibraryItem,
    query: Record<string, unknown> | undefined,
): {
    available: boolean;
    getEntities: () => Promise<OfflineDownloadEntity[]>;
} => {
    const server = useCurrentServer();
    const cacheEnabled = useSettingsStore((s) => s.localCache?.enabled === true);
    const cacheAvailable = useCacheStore((s) => s.cacheAvailable);

    const entityType = libraryItemToOfflineEntityType(itemType);
    const available = cacheEnabled && cacheAvailable !== false && entityType !== undefined;

    const getEntities = useCallback(async (): Promise<OfflineDownloadEntity[]> => {
        if (!server?.id || !entityType) return [];

        const apiClientProps = { serverId: server.id };
        const listQuery = {
            ...(query ?? {}),
            limit: LIST_SOURCE_FETCH_LIMIT,
            startIndex: 0,
        } as never;

        const toEntities = (
            items: undefined | { id: string; name: string }[],
        ): OfflineDownloadEntity[] =>
            (items ?? [])
                .filter((item) => item.id)
                .map((item) => ({ entityType, id: item.id, name: item.name }));

        switch (itemType) {
            case LibraryItem.ALBUM: {
                const res = await api.controller.getAlbumList({ apiClientProps, query: listQuery });
                return toEntities(res?.items);
            }
            case LibraryItem.ALBUM_ARTIST: {
                const res = await api.controller.getAlbumArtistList({
                    apiClientProps,
                    query: listQuery,
                });
                return toEntities(res?.items);
            }
            case LibraryItem.ARTIST: {
                const res = await api.controller.getArtistList({
                    apiClientProps,
                    query: listQuery,
                });
                return toEntities(res?.items);
            }
            case LibraryItem.GENRE: {
                const res = await api.controller.getGenreList({ apiClientProps, query: listQuery });
                return toEntities(res?.items);
            }
            case LibraryItem.PLAYLIST: {
                const res = await api.controller.getPlaylistList({
                    apiClientProps,
                    query: listQuery,
                });
                return toEntities(res?.items);
            }
            case LibraryItem.SONG: {
                const res = await api.controller.getSongList({ apiClientProps, query: listQuery });
                return toEntities(res?.items);
            }
            default:
                return [];
        }
    }, [entityType, itemType, query, server]);

    return useMemo(() => ({ available, getEntities }), [available, getEntities]);
};
