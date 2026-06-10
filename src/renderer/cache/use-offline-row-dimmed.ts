// use-offline-row-dimmed — whether a song row should render greyed-out because
// the app is OFFLINE and the song has no downloaded copy (so it can't play).
//
// Reads from the in-memory offline-availability snapshot (cache store) — NO
// Dexie query per row. The snapshot Set's identity only changes when
// membership changes, so the per-row store subscription is cheap even in a
// large virtualized list. Combined with the connectivity signal so rows are
// only dimmed while offline (everything is playable online).

import { useCacheStore } from './store';

import { useIsOnline } from '/@/renderer/lib/network-status';
import { LibraryItem } from '/@/shared/types/domain-types';

// The row item shapes that can carry a downloadable song.
interface MaybeSongRow {
    _itemType?: LibraryItem;
    _serverId?: string;
    id?: string;
}

const SONG_ITEM_TYPES = new Set<LibraryItem>([
    LibraryItem.PLAYLIST_SONG,
    LibraryItem.QUEUE_SONG,
    LibraryItem.SONG,
]);

/**
 * True when `item` is a song that should render greyed-out: the app is offline
 * AND the song has no downloaded blob. Non-song rows and online sessions never
 * dim. Safe to call with `null`/`undefined` (returns false).
 */
export const useOfflineRowDimmed = (item: unknown): boolean => {
    const online = useIsOnline();
    const row = (item ?? undefined) as MaybeSongRow | undefined;
    const serverId = row?._serverId;
    const songId = row?.id;
    const isSong =
        !!row &&
        (row._itemType === undefined ? !!serverId && !!songId : SONG_ITEM_TYPES.has(row._itemType));

    const available = useCacheStore((s) =>
        serverId && songId ? s.offlineAvailability.songKeys.has(`${serverId}:${songId}`) : false,
    );

    if (online || !isSong || !serverId || !songId) return false;
    return !available;
};
