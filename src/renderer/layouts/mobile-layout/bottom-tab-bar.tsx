import clsx from 'clsx';
import { motion } from 'motion/react';
import { ReactNode } from 'react';
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
} from 'react-icons/ri';
import { generatePath, useLocation, useNavigate } from 'react-router';

import styles from './bottom-tab-bar.module.css';

import { AppRoute } from '/@/renderer/router/routes';
import { LibraryItem } from '/@/shared/types/domain-types';

interface BottomTabBarProps {
    /** Whether the side drawer (the More tab's destination) is currently open. */
    drawerOpen: boolean;
    /** Open the drawer when the More tab is tapped. */
    onMoreTab: () => void;
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

type TabKey = 'home' | 'library' | 'more' | 'search';

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
export const BottomTabBar = ({ drawerOpen, onMoreTab }: BottomTabBarProps) => {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();

    // Pre-computed for the active-state check so we don't pay the generatePath
    // cost on every render or for every tab comparison.
    const searchPath = generatePath(AppRoute.SEARCH, { itemType: LibraryItem.SONG });

    const tabs: Tab[] = [
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
            isActive: (p) => p.startsWith('/search'),
            key: 'search',
            label: t('page.sidebar.search', { defaultValue: 'Search' }),
            onClick: () => navigate(searchPath),
        },
        {
            icon: (active) =>
                active ? <RiAlbumFill size="1.5rem" /> : <RiAlbumLine size="1.5rem" />,
            // Anything under /library OR /playlists is "your library" in Spotify terms.
            isActive: (p) => p.startsWith('/library') || p.startsWith('/playlists'),
            key: 'library',
            label: t('page.sidebar.myLibrary', { defaultValue: 'Library' }),
            onClick: () => navigate(AppRoute.LIBRARY_ALBUMS),
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
    ];

    return (
        <nav
            aria-label={t('common.primaryNavigation', { defaultValue: 'Primary navigation' })}
            className={styles.tabBar}
            id="mobile-bottom-tab-bar"
            role="tablist"
        >
            {tabs.map((tab) => {
                const active = tab.isActive(location.pathname);
                return (
                    <button
                        aria-current={active ? 'page' : undefined}
                        aria-label={tab.label}
                        aria-selected={active}
                        className={clsx(styles.tab, { [styles.active]: active })}
                        key={tab.key}
                        onClick={tab.onClick}
                        role="tab"
                        type="button"
                    >
                        <span className={styles.iconSlot}>
                            {tab.icon(active)}
                            {active && (
                                <motion.span
                                    className={styles.activeDot}
                                    layoutId="bottom-tab-bar-active-dot"
                                    transition={{
                                        damping: 24,
                                        mass: 0.6,
                                        stiffness: 380,
                                        type: 'spring',
                                    }}
                                />
                            )}
                        </span>
                        <span className={styles.label}>{tab.label}</span>
                    </button>
                );
            })}
        </nav>
    );
};
