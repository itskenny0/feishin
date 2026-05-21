import { Capacitor } from '@capacitor/core';
import { useMediaQuery } from '@mantine/hooks';

import { useSettingsStore } from '/@/renderer/store/settings.store';

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
 * Sub-tier hooks (`useIsSmallPhone`, `useIsBigPhone`, `useIsTabletRange`,
 * `useIsBigTablet`) carve finer-grained ranges out of the named tiers
 * above — pair each with a CSS media query at the same boundary.
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

/**
 * Query that matches "this device should render the mobile shell" — i.e.
 * a phone in either orientation.
 *
 * The first clause `(max-width: 767px)` catches every phone in portrait
 * and small phones in landscape (≤ 767 wide). The second clause catches
 * the missing case: modern phones in landscape, which run 800–1000px wide
 * but only 350–480px tall. Without that clause a Pixel 9 Pro rotated
 * sideways (994 × 448) would fall through to the desktop shell — collapsed
 * sidebar, desktop playerbar grid, dual nav arrows — which looks broken
 * on a phone screen.
 *
 * 480px is the height cutoff because no tablet in landscape is that short
 * (iPad mini landscape is 744 tall; even foldables in book mode stay
 * ≥ 600 tall) but every phone in landscape sits comfortably under it.
 * Portrait tablets (iPad mini 744 × 1133) are never matched because their
 * width is > 767 and they're not in landscape.
 *
 * Keep the corresponding CSS-side rules using the same combined expression
 * (`@media (max-width: 767px), (orientation: landscape) and (max-height: 480px)`)
 * so JS-gated rendering and CSS-gated styling line up.
 */
export const MOBILE_SHELL_QUERY =
    '(max-width: 767px), (orientation: landscape) and (max-height: 480px)';

/**
 * True for phone + phablet (i.e. anything below the desktop shell), OR
 * when the user has flipped the "force mobile view" override in settings.
 * The override lets users opt into the touch-first Spotify-style UI on
 * larger displays where the responsive media query would otherwise pick
 * the desktop shell.
 */
export const useIsMobileShell = () => {
    const matches = useMediaQuery(MOBILE_SHELL_QUERY);
    const force = useSettingsStore((state) => state.general.mobileShellForce);
    return matches || force;
};

/**
 * True for sub-360px viewports — Pixel 4a, Galaxy S10e, iPhone SE 1st gen,
 * older budget Androids, narrow foldable inner panes. Used to drop two-
 * column grids, tighten chrome, and shrink fullscreen player gutters where
 * every horizontal pixel matters. Keep paired with `@media (width <= 360px)`
 * in CSS modules.
 */
export const useIsSmallPhone = () => useMediaQuery('(max-width: 360px)');

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

/**
 * True when the viewport sits in the 431–834px "tablet sweet-spot" — the
 * range that straddles the 768px mobile/desktop shell boundary. Covers
 * large phones in landscape (430–600), small portrait tablets (744–810),
 * narrow split-screen desktop windows and book-mode foldables.
 *
 * Devices in this range have plenty of horizontal space but are commonly
 * held in portrait with two thumbs, so layouts that look right on phones
 * (single column, full-bleed art) waste room here, and layouts tuned for
 * desktop (resizable sidebar, queue sidebar, dense tables) feel cramped.
 *
 * The 768 mobile-shell boundary is preserved — useIsTabletRange spans
 * BOTH shells. Below 768 the mobile shell stays in charge (with
 * tablet-flavoured polish layered on top via `@media (min-width: 600px)`
 * style queries inside the mobile-shell components). Above 768 the
 * desktop shell renders but with tablet-tuned defaults (auto-collapsed
 * sidebar, queue sidebar suppressed, earlier two-column detail layouts).
 */
export const useIsTabletRange = () => useMediaQuery('(min-width: 431px) and (max-width: 834px)');

/**
 * True when running inside the Capacitor Android WebView (the packaged
 * mobile app), false on Electron desktop / web / iOS. Synchronous —
 * Capacitor.getPlatform() returns 'web' / 'android' / 'ios' at module
 * load time without any async resolution.
 *
 * Use this to suppress in-app affordances that the host OS already
 * handles natively. Two current callers:
 *   - The volume sliders are hidden on Android because the OS volume
 *     rocker is the single source of truth (Spotify / Apple Music
 *     pattern).
 *   - Anywhere else we want "this is the packaged Android app", not
 *     "this viewport is phone-shaped" (use `useIsMobileShell` for the
 *     latter — Capacitor Android can also be installed on tablets, and
 *     a desktop browser window resized to 400×800 is not the Android
 *     app).
 */
const IS_ANDROID_NATIVE = Capacitor.getPlatform() === 'android';
export const useIsAndroidNative = () => IS_ANDROID_NATIVE;

/**
 * True when the viewport is in the "big-tablet" range (835–1280px). Covers
 * iPad portrait edge cases (820–834), iPad Pro 11" landscape (834×1194),
 * iPad Pro 12.9" portrait (1024×1366), iPad landscape (1180×820), Samsung
 * Galaxy Tab S9 Ultra landscape, ChromeOS tablet mode, foldable outers and
 * small Surface devices.
 *
 * This tier overlaps both the legacy `tablet` shell (835–1199) and the
 * bottom slice of the `desktop` shell (1200–1280). It is a layout-tweak
 * signal, not a shell selector — the actual layout shell is still chosen
 * by `useIsMobileShell()`. Pair with `@media (min-width: 835px) and
 * (max-width: 1280px)` in CSS modules.
 */
export const useIsBigTablet = () => useMediaQuery('(min-width: 835px) and (max-width: 1280px)');
