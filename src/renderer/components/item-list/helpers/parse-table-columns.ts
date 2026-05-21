import { ItemTableListColumnConfig } from '/@/renderer/components/item-list/types';
import { TableColumn } from '/@/shared/types/types';

/**
 * Columns that get hidden on narrow viewports (the mobile shell) even when
 * the user's saved settings have them enabled. On a 360-480px screen the
 * essential signal is title + duration + maybe rating; album / year /
 * release-date / disc / track / genre etc. just push the title into
 * truncation and the actionable cells off-screen.
 *
 * Album-grouping is preserved (it's a structural column, not informational).
 * Album row-level fields are dropped — the user already knows what album
 * they're inside from the page title / hero header.
 */
const MOBILE_DEPRIORITISED_COLUMNS: ReadonlySet<TableColumn> = new Set([
    TableColumn.ALBUM,
    TableColumn.ALBUM_ARTIST,
    TableColumn.ARTIST,
    TableColumn.BIT_DEPTH,
    TableColumn.BIT_RATE,
    TableColumn.BPM,
    TableColumn.CHANNELS,
    TableColumn.COMMENT,
    TableColumn.COMPOSER,
    TableColumn.DATE_ADDED,
    TableColumn.DISC_NUMBER,
    TableColumn.GENRE,
    TableColumn.GENRE_BADGE,
    TableColumn.LAST_PLAYED,
    TableColumn.PATH,
    TableColumn.PLAY_COUNT,
    TableColumn.RELEASE_DATE,
    TableColumn.SIZE,
    TableColumn.TRACK_NUMBER,
    TableColumn.USER_RATING,
    TableColumn.YEAR,
]);

interface ParseTableColumnsOptions {
    /**
     * When true, drop the columns in {@link MOBILE_DEPRIORITISED_COLUMNS}
     * even if they're isEnabled in the user's saved settings. Caller
     * passes useIsMobileShell() or equivalent.
     */
    trimForMobile?: boolean;
}

/**
 * Sorts table columns by their pinned position and filters out disabled columns:
 * - Left pinned columns come first (maintaining their original order)
 * - Unpinned columns come next (maintaining their original order)
 * - Right pinned columns come last (maintaining their original order)
 * - Columns with isEnabled: false are removed
 *
 * When {@link ParseTableColumnsOptions.trimForMobile} is true, deprioritised
 * informational columns (album, year, genre, etc.) are filtered out so the
 * essential title + duration columns get the available horizontal space on
 * narrow phone viewports.
 */
export const parseTableColumns = (
    columns: ItemTableListColumnConfig[],
    options: ParseTableColumnsOptions = {},
): ItemTableListColumnConfig[] => {
    const { trimForMobile = false } = options;
    const leftPinned: ItemTableListColumnConfig[] = [];
    const unpinned: ItemTableListColumnConfig[] = [];
    const rightPinned: ItemTableListColumnConfig[] = [];

    // Separate columns by pinned position while maintaining original order
    // Only include columns that are enabled (isEnabled !== false)
    columns.forEach((column) => {
        if (column.isEnabled === false) {
            return;
        }
        if (trimForMobile && MOBILE_DEPRIORITISED_COLUMNS.has(column.id)) {
            return;
        }

        switch (column.pinned) {
            case 'left':
                leftPinned.push(column);
                break;
            case 'right':
                rightPinned.push(column);
                break;
            case null:
            default:
                unpinned.push(column);
                break;
        }
    });

    // Combine in the desired order: left pinned, unpinned, right pinned
    return [...leftPinned, ...unpinned, ...rightPinned];
};
