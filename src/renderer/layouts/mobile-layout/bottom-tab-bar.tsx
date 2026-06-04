import clsx from 'clsx';
import { motion, useReducedMotion } from 'motion/react';
import { ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    RiAlbumFill,
    RiAlbumLine,
    RiHome6Fill,
    RiHome6Line,
    RiMenuFill,
    RiMenuLine,
    RiSearchFill,
    RiSearchLine,
    RiSettings3Fill,
    RiSettings3Line,
} from 'react-icons/ri';
import { generatePath, useLocation, useNavigate } from 'react-router';

import styles from './bottom-tab-bar.module.css';
import { MyLibraryPopover } from './my-library-popover';

import { useHaptic } from '/@/renderer/hooks/use-haptic';
import { AppRoute } from '/@/renderer/router/routes';
import { LibraryItem } from '/@/shared/types/domain-types';

interface BottomTabBarProps {
    /** Whether the side drawer (the More tab's destination) is currently open. */
    drawerOpen: boolean;
    /** Open the drawer when the More tab is tapped. */
    onMoreTab: () => void;
    /**
     * Called when the user taps a tab whose route is already active —
     * the host scrolls the main content to top (Spotify pattern).
     */
    onScrollToTop?: () => void;
}

interface Tab {
    /** Rendered icon - takes (active: boolean). */
    icon: (active: boolean) => ReactNode;
    /** True if the current location belongs to this tab. */
    isActive: (pathname: string) => boolean;
    /** Identifier for keying + active comparisons. */
    key: TabKey;
    /** Translated label shown under the icon. */
    label: string;
    /** Click handler. Either navigates to a route or opens the drawer. */
    onClick: () => void;
}

type TabKey = 'home' | 'library' | 'more' | 'search' | 'settings';

/**
 * Persistent bottom tab bar shown on the mobile shell (<768px).
 *
 * Spotify-style: four equal slots (Home / Search / Library / More). The
 * "More" tab opens the existing left drawer (everything that isn't one of the
 * three primary destinations — Playlists, Settings, Servers, etc.).
 *
 * Tapping a tab whose route is already the current location is a no-op rather
 * than a re-navigation, so the user doesn't lose scroll position when they
 * accidentally tap the active tab.
 */
export const BottomTabBar = ({ drawerOpen, onMoreTab, onScrollToTop }: BottomTabBarProps) => {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const haptic = useHaptic();
    const reduceMotion = useReducedMotion();

    // Pre-computed for the active-state check so we don't pay the generatePath
    // cost on every render or for every tab comparison.
    const searchPath = generatePath(AppRoute.SEARCH, { itemType: LibraryItem.SONG });

    /*
     * The "Library" tab opens a bottom-sheet popover listing the library
     * entity types (Albums / Songs / Favourites / Artists / Genres /
     * Playlists / …), mirroring the sidebar's "My Library" section, rather
     * than jumping straight to a single default destination.
     */
    const [libraryPopoverOpen, setLibraryPopoverOpen] = useState(false);
    const openLibraryPopover = useCallback(() => {
        console.info('[mobile-nav] my-library popover opened');
        setLibraryPopoverOpen(true);
    }, []);
    const closeLibraryPopover = useCallback(() => setLibraryPopoverOpen(false), []);

    const tabs: Tab[] = useMemo(
        () => [
            {
                icon: (active) =>
                    active ? <RiHome6Fill size="1.5rem" /> : <RiHome6Line size="1.5rem" />,
                isActive: (p) => p === AppRoute.HOME,
                key: 'home',
                label: t('page.sidebar.home', { defaultValue: 'Home' }),
                onClick: () => navigate(AppRoute.HOME),
            },
            {
                icon: (active) =>
                    active ? <RiSearchFill size="1.5rem" /> : <RiSearchLine size="1.5rem" />,
                // Search tab is "active" whenever the dedicated search route
                // is displayed.
                isActive: (p) => p.startsWith('/search'),
                key: 'search',
                label: t('page.sidebar.search', { defaultValue: 'Search' }),
                // Navigate to the real in-layout search PAGE (with the bottom
                // tab bar + mini-player visible), NOT the command-palette
                // overlay. The palette stays mounted globally and is reachable
                // from the search page header's "commands" affordance.
                onClick: () => navigate(searchPath),
            },
            {
                icon: (active) =>
                    active ? <RiAlbumFill size="1.5rem" /> : <RiAlbumLine size="1.5rem" />,
                // Anything under /library OR /playlists is "your library" in
                // Spotify terms, OR while the library popover itself is open so
                // the tab stays visually anchored.
                isActive: (p) =>
                    libraryPopoverOpen || p.startsWith('/library') || p.startsWith('/playlists'),
                key: 'library',
                label: t('page.sidebar.myLibrary', { defaultValue: 'Library' }),
                // Open the entity-type popover instead of navigating.
                onClick: openLibraryPopover,
            },
            {
                // Settings as a first-class tab. The previous path was More →
                // sidebar drawer → Settings, which is two taps for a destination
                // that gets visited often (servers, themes, playback). Sits
                // immediately left of the More overflow so the visual centre of
                // gravity stays balanced.
                icon: (active) =>
                    active ? <RiSettings3Fill size="1.5rem" /> : <RiSettings3Line size="1.5rem" />,
                isActive: (p) => p.startsWith('/settings'),
                key: 'settings',
                label: t('page.sidebar.settings', { defaultValue: 'Settings' }),
                onClick: () => navigate(AppRoute.SETTINGS),
            },
            {
                // "More" stays active while the drawer is open so the user has a
                // visual anchor when they're inside it.
                icon: (active) =>
                    active ? <RiMenuFill size="1.5rem" /> : <RiMenuLine size="1.5rem" />,
                isActive: () => drawerOpen,
                key: 'more',
                label: t('common.menu', { defaultValue: 'More' }),
                onClick: onMoreTab,
            },
        ],
        [drawerOpen, libraryPopoverOpen, navigate, onMoreTab, openLibraryPopover, searchPath, t],
    );

    /*
     * Compute the single tab that owns the sliding active-dot.
     *
     * Several tabs can report `isActive === true` at the same instant — e.g.
     * the More drawer can be open *over* a /library route (both `more` and
     * `library` match), or the Library popover can be open while the user is
     * already on a /library page. The active-dot is a shared-layout element
     * (one `layoutId`), and motion only permits a SINGLE node per layoutId at
     * a time: rendering two warns in the console and tears the slide
     * animation (the dot jumps or disappears). So we pick exactly one owner.
     *
     * Priority: a foreground toggle overlay (More drawer / Library popover)
     * wins, because that's what the user is actively looking at; otherwise
     * the first route-matched tab in declaration order takes the dot.
     */
    const activeDotKey: null | TabKey = useMemo(() => {
        if (drawerOpen) return 'more';
        if (libraryPopoverOpen) return 'library';
        return tabs.find((tab) => tab.isActive(location.pathname))?.key ?? null;
    }, [drawerOpen, libraryPopoverOpen, location.pathname, tabs]);

    return (
        <>
            <nav
                aria-label={t('common.primaryNavigation', { defaultValue: 'Primary navigation' })}
                className={styles.tabBar}
                id="mobile-bottom-tab-bar"
                role="tablist"
            >
                {tabs.map((tab) => {
                    const active = tab.isActive(location.pathname);
                    // Only the single elected owner paints the shared-layout
                    // dot (see activeDotKey) so motion never sees a duplicate
                    // layoutId.
                    const showDot = tab.key === activeDotKey;
                    return (
                        <button
                            aria-current={active ? 'page' : undefined}
                            aria-label={tab.label}
                            aria-selected={active}
                            className={clsx(styles.tab, { [styles.active]: active })}
                            key={tab.key}
                            onClick={() => {
                                // Tiny tick on tab switch. The More and
                                // Library tabs are toggles (active means
                                // their drawer / popover is open) so we
                                // fire on every tap there — every press
                                // either opens or closes the overlay.
                                // Other tabs only buzz on the move that
                                // changes routes.
                                const isToggleTab = tab.key === 'more' || tab.key === 'library';
                                if (!active || isToggleTab) {
                                    haptic('selection');
                                }
                                // Spotify pattern: re-tapping the active
                                // tab scrolls the main content to top
                                // instead of re-navigating. Skipped for
                                // the toggle tabs (their onClick toggles
                                // the drawer / popover).
                                if (active && !isToggleTab && onScrollToTop) {
                                    onScrollToTop();
                                    return;
                                }
                                tab.onClick();
                            }}
                            role="tab"
                            type="button"
                        >
                            <span className={styles.iconSlot}>
                                {tab.icon(active)}
                                {showDot && (
                                    <motion.span
                                        className={styles.activeDot}
                                        data-testid="bottom-tab-active-dot"
                                        layoutId="bottom-tab-bar-active-dot"
                                        transition={
                                            reduceMotion
                                                ? { duration: 0 }
                                                : {
                                                      damping: 24,
                                                      mass: 0.6,
                                                      stiffness: 380,
                                                      type: 'spring',
                                                  }
                                        }
                                    />
                                )}
                            </span>
                            <span className={styles.label}>{tab.label}</span>
                        </button>
                    );
                })}
            </nav>
            <MyLibraryPopover onClose={closeLibraryPopover} opened={libraryPopoverOpen} />
        </>
    );
};
