import { UnstyledButton } from '@mantine/core';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './my-library-popover.module.css';

import { useOfflineSongCount } from '/@/renderer/cache';
import { BottomSheet } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet';
import { SidebarIcon } from '/@/renderer/features/sidebar/components/sidebar-icon';
import { useHaptic } from '/@/renderer/hooks/use-haptic';
import { AppRoute } from '/@/renderer/router/routes';
import { SidebarItemType, useSidebarItems } from '/@/renderer/store/settings.store';
import { Portal } from '/@/shared/components/portal/portal';

interface MyLibraryPopoverProps {
    onClose: () => void;
    opened: boolean;
}

/**
 * Mobile "My Library" picker — opened from the bottom tab bar's Library tab.
 *
 * Mirrors the sidebar's "My Library" accordion section (see
 * `sidebar.tsx` / `mobile-sidebar.tsx`) by consuming the SAME shared store
 * source — `useSidebarItems()` — so the list never diverges from the
 * sidebar. We apply the identical filter the sidebar uses: drop disabled
 * items, drop the Collections pseudo-entry, and drop anything without a
 * route. Labels are translated against `page.sidebar.*` exactly as the
 * sidebar maps them.
 *
 * Rendered inside the shared `BottomSheet`, so it inherits backdrop-tap /
 * swipe-down / Android-back dismissal, safe-area insets, body-scroll lock,
 * focus restore and an internally scrollable body — no extra wiring needed
 * here.
 */
export const MyLibraryPopover = ({ onClose, opened }: MyLibraryPopoverProps) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const haptic = useHaptic();
    const sidebarItems = useSidebarItems();
    // Reactive count of downloaded tracks — drives the hidden-when-empty
    // "Available offline" entry below.
    const offlineSongCount = useOfflineSongCount();

    // Same id → label map the sidebar uses, kept in sync with the
    // `page.sidebar.*` keys. Memoised so the entries array below stays
    // referentially stable across renders.
    const translatedSidebarItemMap = useMemo(
        () => ({
            Albums: t('page.sidebar.albums', { defaultValue: 'Albums' }),
            Artists: t('page.sidebar.albumArtists', { defaultValue: 'Album Artists' }),
            'Artists-all': t('page.sidebar.artists', { defaultValue: 'Artists' }),
            Favorites: t('page.sidebar.favorites', { defaultValue: 'Favorites' }),
            Folders: t('page.sidebar.folders', { defaultValue: 'Folders' }),
            Genres: t('page.sidebar.genres', { defaultValue: 'Genres' }),
            Home: t('page.sidebar.home', { defaultValue: 'Home' }),
            'Now Playing': t('page.sidebar.nowPlaying', { defaultValue: 'Now Playing' }),
            Playlists: t('page.sidebar.playlists', { defaultValue: 'Playlists' }),
            Radio: t('page.sidebar.radio', { defaultValue: 'Radio' }),
            Search: t('page.sidebar.search', { defaultValue: 'Search' }),
            Settings: t('page.sidebar.settings', { defaultValue: 'Settings' }),
            Tracks: t('page.sidebar.tracks', { defaultValue: 'Songs' }),
        }),
        [t],
    );

    // Library entries, mirroring the sidebar's `libraryItemsWithRoute`:
    // enabled, has a route, and not the Collections pseudo-section.
    //
    // Exception: sidebar-pinned library sections (Playlists) are marked
    // `disabled` in the default sidebar item list because the desktop
    // sidebar surfaces them through a dedicated section (the playlist
    // tree) rather than the "My Library" accordion. Mobile has no such
    // persistent sidebar, so those sections must still appear here —
    // otherwise they'd be unreachable from the mobile Library tab. We
    // therefore keep them regardless of the `disabled` flag.
    const alwaysIncludeIds = useMemo(() => new Set<SidebarItemType['id']>(['Playlists']), []);

    const entries: SidebarItemType[] = useMemo(() => {
        if (!sidebarItems) return [];
        const items = sidebarItems
            .filter(
                (item) =>
                    (!item.disabled || alwaysIncludeIds.has(item.id)) &&
                    item.id !== 'Collections' &&
                    item.route,
            )
            .map((item) => ({
                ...item,
                label:
                    translatedSidebarItemMap[item.id as keyof typeof translatedSidebarItemMap] ??
                    item.label,
            }));

        // Append the "Available offline" entry only when something is
        // downloaded (hidden-when-empty); injected here, not persisted to the
        // configurable sidebarItems list, so it stays reactive.
        if (offlineSongCount > 0) {
            items.push({
                disabled: false,
                id: 'Offline',
                label: t('page.sidebar.offline', { defaultValue: 'Available offline' }),
                route: AppRoute.LIBRARY_OFFLINE,
            });
        }

        return items;
    }, [sidebarItems, translatedSidebarItemMap, alwaysIncludeIds, offlineSongCount, t]);

    const handleSelect = useCallback(
        (route: string) => {
            // Light tick on selection (no-ops on desktop / iOS Safari).
            haptic('selection');
            navigate(route);
            onClose();
        },
        [haptic, navigate, onClose],
    );

    return (
        // Portal to <body> so the sheet escapes any `container-type` /
        // stacking-context ancestor in the mobile-layout chrome and reliably
        // paints above the player bar + bottom tab bar (mirrors the
        // device-picker sheet fix). Harmless when `opened` is false.
        <Portal>
            <BottomSheet
                ariaLabel={t('page.sidebar.myLibrary', { defaultValue: 'My Library' })}
                onClose={onClose}
                opened={opened}
                title={t('page.sidebar.myLibrary', { defaultValue: 'My Library' })}
            >
                <div className={styles.list} data-testid="my-library-popover-list" role="menu">
                    {entries.map((item) => (
                        <UnstyledButton
                            className={styles.row}
                            data-testid={`my-library-entry-${item.id}`}
                            key={`my-library-${item.route}`}
                            onClick={() => handleSelect(item.route)}
                            role="menuitem"
                        >
                            <span className={styles.iconWrap}>
                                <SidebarIcon active={false} route={item.route} size="1.25rem" />
                            </span>
                            <span className={styles.rowLabel}>{item.label}</span>
                        </UnstyledButton>
                    ))}
                </div>
            </BottomSheet>
        </Portal>
    );
};
