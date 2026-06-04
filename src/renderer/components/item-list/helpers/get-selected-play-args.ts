import { ItemListStateItemWithRequiredProperties } from '/@/renderer/components/item-list/helpers/item-list-state';

export interface SelectedPlayArgsGroup {
    ids: string[];
    serverId: string;
}

/**
 * Maps a list selection into the arguments needed to play the WHOLE selection
 * via `player.addToQueueByFetch(serverId, ids, itemType, playType)`.
 *
 * Background: the per-row hover "play" control plays a single row
 * (`onPlay` → `addToQueueByFetch(serverId, [id], ...)`). The list play-HOTKEYS
 * must instead play every selected row (matching the context-menu play path,
 * which does `items.map(i => i.id)`). This helper is the unit-testable seam
 * that turns `internalState.getSelected()` into the id array(s) to play.
 *
 * - Preserves selection/display order (the caller passes items already in that
 *   order; we do not re-sort here).
 * - De-duplicates repeated ids within a server group (a row can only be
 *   enqueued once per play action), keeping first-seen order.
 * - Groups by `_serverId` so a cross-server selection still issues one
 *   well-formed fetch per server rather than mixing ids under a single server.
 *   In practice a list is single-server, so this is normally one group.
 *
 * @param items Selected items, already filtered to those carrying the required
 *   `id` / `_serverId` properties, in selection/display order.
 * @returns One group per distinct server, in first-seen server order. Empty
 *   when the selection is empty.
 */
export const getSelectedPlayArgs = (
    items: ItemListStateItemWithRequiredProperties[],
): SelectedPlayArgsGroup[] => {
    const groups: SelectedPlayArgsGroup[] = [];
    const groupByServer = new Map<string, SelectedPlayArgsGroup>();
    const seenIdsByServer = new Map<string, Set<string>>();

    for (const item of items) {
        const { _serverId: serverId, id } = item;
        if (!serverId || !id) continue;

        let group = groupByServer.get(serverId);
        if (!group) {
            group = { ids: [], serverId };
            groupByServer.set(serverId, group);
            seenIdsByServer.set(serverId, new Set());
            groups.push(group);
        }

        const seen = seenIdsByServer.get(serverId)!;
        if (seen.has(id)) continue;
        seen.add(id);
        group.ids.push(id);
    }

    return groups;
};
