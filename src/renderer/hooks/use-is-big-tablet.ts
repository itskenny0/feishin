import { useMediaQuery } from '@mantine/hooks';

/**
 * Returns true when the viewport is in the "big-tablet" range: 835px-1280px.
 *
 * This tier covers iPad portrait edge cases (834-820), iPad Pro 11" landscape (834x1194),
 * iPad Pro 12.9" portrait (1024x1366), iPad landscape (1180x820), Samsung Galaxy Tab S9 Ultra
 * landscape, ChromeOS tablet mode, foldable outers and small Surface devices.
 *
 * The matching `@media` block is `(min-width: 835px) and (max-width: 1280px)` -- use that
 * literal query in `.module.css` files when component styles need to opt in to the same tier.
 *
 * NOTE: this tier overlaps both the legacy `tablet` shell (835-1199) and the bottom slice of
 * the `desktop` shell (1200-1280). It is intentionally a layout-tweak signal, not a shell
 * selector -- the actual layout shell is still chosen by `useIsMobile()`.
 */
export const useIsBigTablet = () => {
    return useMediaQuery('(min-width: 835px) and (max-width: 1280px)') ?? false;
};
