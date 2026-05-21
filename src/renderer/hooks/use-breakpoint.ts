import { useMediaQuery } from '@mantine/hooks';

/**
 * Named breakpoints for the responsive redesign.
 *
 *   phone   — small phones, portrait                   (< 480px)
 *   phablet — large phones or small landscape phones   (480–767px)
 *   tablet  — tablets and narrow desktop windows       (768–1199px)
 *   desktop — comfortable desktop                       (≥ 1200px)
 *
 * 768px stays the boundary between "mobile shell" (bottom tabs + mini-player +
 * fullscreen-route variants) and "desktop shell" (sidebar + queue sidebar +
 * docked playerbar) so existing `useIsMobile()` semantics are preserved.
 *
 * The phone/phablet split exists so layouts can tighten a touch more at <480px
 * (e.g. drop two-column album grids) without affecting the broader phablet
 * range; the tablet/desktop split exists so we can widen grid columns at
 * ≥1200px without regressing 13"-laptop windows.
 *
 * Add CSS-side breakpoints in /shared/styles/global.css under the same names
 * if you need to branch from CSS — keep both definitions in sync.
 */
export type Breakpoint = 'desktop' | 'phablet' | 'phone' | 'tablet';

export const BREAKPOINT_QUERIES: Record<Breakpoint, string> = {
    desktop: '(min-width: 1200px)',
    phablet: '(min-width: 480px) and (max-width: 767px)',
    phone: '(max-width: 479px)',
    tablet: '(min-width: 768px) and (max-width: 1199px)',
};

/**
 * Sub-range query inside `phone` covering modern flagship-sized phones in
 * portrait — iPhone 13/14/15 (390px), Pro Max (430px), Pixel 7/8/8 Pro
 * (412px), Galaxy S24 / S24 Ultra (384–412px), iPhone 13 Mini (375px).
 *
 * Big-phone covers the majority of mobile traffic and has comfortable but
 * not luxurious horizontal space (enough for a 2-col grid with proper
 * cover-art presence, richer mini-player metadata, intentionally laid-out
 * tab labels — but not so much that we should switch to tablet layouts).
 *
 * Pair with CSS media queries at the same boundaries:
 *
 *   @media (min-width: 361px) and (max-width: 430px) { ... }
 *
 * Keep the JS and CSS sides aligned. Sub-360 ("small phone") and ≥431
 * ("phablet+") deliberately get separate treatments.
 */
export const BIG_PHONE_QUERY = '(min-width: 361px) and (max-width: 430px)';

/**
 * Returns the currently active named breakpoint.
 *
 * SSR-safe: useMediaQuery returns false on the server, so we fall back to
 * `desktop` (the densest layout) to avoid mobile UI flashing on hydration
 * for desktop users.
 */
export const useBreakpoint = (): Breakpoint => {
    const isPhone = useMediaQuery(BREAKPOINT_QUERIES.phone);
    const isPhablet = useMediaQuery(BREAKPOINT_QUERIES.phablet);
    const isTablet = useMediaQuery(BREAKPOINT_QUERIES.tablet);
    if (isPhone) return 'phone';
    if (isPhablet) return 'phablet';
    if (isTablet) return 'tablet';
    return 'desktop';
};

/** True for phone + phablet (i.e. anything below the desktop shell). */
export const useIsMobileShell = () => useMediaQuery('(max-width: 767px)');

/** True for phone-sized screens only — use sparingly, prefer useBreakpoint. */
export const useIsPhone = () => useMediaQuery(BREAKPOINT_QUERIES.phone);

/**
 * True for the big-phone tier (361–430px). Flagship phones in portrait —
 * iPhone 13/14/15, Pro Max, Pixel 7/8/8 Pro, Galaxy S24, etc. Use this to
 * unlock the richer mobile layouts (lusher fullscreen player, denser
 * mini-player metadata, intentional tab-bar labels) without affecting
 * cramped sub-360 viewports or phablets ≥431.
 */
export const useIsBigPhone = () => useMediaQuery(BIG_PHONE_QUERY);

/** True for tablet or smaller — useful for hiding the queue sidebar. */
export const useIsTabletOrSmaller = () => useMediaQuery('(max-width: 1199px)');

/** True for genuine pointer:coarse devices (touch). Pair with breakpoint checks. */
export const useIsTouch = () => useMediaQuery('(pointer: coarse)');
