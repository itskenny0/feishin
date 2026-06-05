/**
 * Dependency-free grid layout helpers shared by the virtualized grid
 * (`item-grid-list.tsx`) and its loading skeleton (`list-skeleton.tsx`).
 *
 * This module intentionally imports neither `react-window` nor `motion` nor
 * any card component, so consumers that only need the column-count math (e.g.
 * the route skeleton) can pull it in WITHOUT dragging the grid engine into
 * their chunk. Keep it pure.
 */

export type GridCardCornerRadius = 'pill' | 'rounded-lg' | 'rounded-md' | 'rounded-sm' | 'square';

/**
 * Maps the user-facing grid-card corner-radius setting onto a CSS length the
 * cards consume via the `--card-corner-radius` custom property. 'rounded-md'
 * resolves to `--theme-radius-md`, reproducing the hardcoded look the cards
 * shipped with, so the default is a no-op.
 */
export const GRID_CARD_CORNER_RADIUS_VALUE: Record<GridCardCornerRadius, string> = {
    pill: 'var(--theme-radius-pill)',
    'rounded-lg': 'var(--theme-radius-lg)',
    'rounded-md': 'var(--theme-radius-md)',
    'rounded-sm': 'var(--theme-radius-sm)',
    square: '0px',
};

/**
 * Maps a measured content width (in px) to the number of grid columns. Keyed
 * on the grid's CONTENT width, not the viewport — in the desktop shell the
 * content area is the viewport minus the sidebar.
 *
 * Tablet content-width tiers: the desktop shell renders for the whole
 * 768-1199 viewport band; with an expanded (240px) sidebar the content area
 * can be as narrow as ~560-700px, which previously fell into the 2-column
 * branch and produced oversized covers on the device class with the most
 * room. Intermediate 3-col (>=540) and 4-col (>=700) steps give tablet content
 * widths a sensible 3-4 columns.
 */
export function getDynamicItemsPerRow(width: number, size?: 'compact' | 'default' | 'large') {
    // Phone tiers (content width < 540 — below the lowest tablet tier).
    //
    // The old tuning collapsed phones to 1 column below 380 and only reached
    // 2 columns up to 540, so a 360-430px phone rendered 1-2 oversized covers
    // and almost nothing fit above the fold. Phones want DENSITY, like the
    // Spotify / Apple Music library grids.
    //
    //   - Small phones (< 384: 320 iPhone SE … 360 Pixel/Android) -> 2 cols.
    //     Two square covers at 360 minus padding leaves ~165px each — a clean,
    //     readable thumbnail rather than one viewport-filling cover.
    //   - Larger phones (384-539: 390 iPhone, 412-430 Pro Max / Android-XL)
    //     -> 3 cols (~120-133px covers), matching the streaming-app density
    //     users expect on a comfortable portrait phone.
    //
    // The >=540 tablet/desktop content-width tiers below are UNCHANGED.
    const isSmallPhone = width < 384;
    const isLargePhone = width < 540;
    const is3col = width >= 540;
    const is4col = width >= 700;
    const isSm = width >= 600;
    const isMd = width >= 768;
    const isLg = width >= 960;
    const isXl = width >= 1200;
    const is2xl = width >= 1440;
    const is3xl = width >= 1920;
    const is4xl = width >= 2560;

    let dynamicItemsPerRow = 2;

    if (is4xl) {
        dynamicItemsPerRow = 10;
    } else if (is3xl) {
        dynamicItemsPerRow = 8;
    } else if (is2xl) {
        dynamicItemsPerRow = 7;
    } else if (isXl) {
        dynamicItemsPerRow = 6;
    } else if (isLg) {
        dynamicItemsPerRow = 5;
    } else if (isMd) {
        dynamicItemsPerRow = 4;
    } else if (is4col) {
        dynamicItemsPerRow = 4;
    } else if (isSm) {
        dynamicItemsPerRow = 3;
    } else if (is3col) {
        dynamicItemsPerRow = 3;
    } else if (isSmallPhone) {
        dynamicItemsPerRow = 2;
    } else if (isLargePhone) {
        dynamicItemsPerRow = 3;
    } else {
        dynamicItemsPerRow = 2;
    }

    if (size === 'large') {
        dynamicItemsPerRow = Math.round(dynamicItemsPerRow * 0.75);
        if (dynamicItemsPerRow < 1) {
            dynamicItemsPerRow = 1;
        }
    }

    return dynamicItemsPerRow;
}
