import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-sidebar.module.css';

import { ActionBar } from '/@/renderer/features/sidebar/components/action-bar';
import { SidebarFavoriteAlbumsList } from '/@/renderer/features/sidebar/components/sidebar-favorite-albums-list';
import { SidebarIcon } from '/@/renderer/features/sidebar/components/sidebar-icon';
import { SidebarItem } from '/@/renderer/features/sidebar/components/sidebar-item';
import {
    SidebarPlaylistAddDragContext,
    SidebarPlaylistList,
    SidebarSharedPlaylistList,
    useSidebarPlaylistAddDragMonitor,
} from '/@/renderer/features/sidebar/components/sidebar-playlist-list';
import { useSidebarItemLabels } from '/@/renderer/features/sidebar/hooks/use-sidebar-item-labels';
import { useSwipeToClose } from '/@/renderer/hooks/use-swipe-to-close';
import {
    SidebarItemType,
    useSidebarBottomSection,
    useSidebarItems,
} from '/@/renderer/store/settings.store';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { Group } from '/@/shared/components/group/group';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Text } from '/@/shared/components/text/text';

const MobileSidebarPlaylistSection = () => {
    const isAddDragActive = useSidebarPlaylistAddDragMonitor();

    return (
        <SidebarPlaylistAddDragContext.Provider value={isAddDragActive}>
            <SidebarPlaylistList />
            <SidebarSharedPlaylistList />
        </SidebarPlaylistAddDragContext.Provider>
    );
};

interface MobileSidebarProps {
    /**
     * Called when the user swipes the drawer toward the left edge of
     * the screen — mirrors Android's standard "swipe-away" gesture so
     * the drawer can be dismissed without reaching for the backdrop or
     * the More tab.
     */
    onSwipeClose?: () => void;
}

export const MobileSidebar = ({ onSwipeClose }: MobileSidebarProps = {}) => {
    const { t } = useTranslation();
    const sidebarBottomSection = useSidebarBottomSection();
    const containerRef = useRef<HTMLDivElement>(null);

    useSwipeToClose(containerRef, {
        direction: 'left',
        disabled: !onSwipeClose,
        onClose: onSwipeClose ?? (() => undefined),
    });

    const labels = useSidebarItemLabels();
    const sidebarItems = useSidebarItems();

    // Collections is a section, not a route (it would render as a dead link here).
    const sidebarItemsWithRoute: SidebarItemType[] = useMemo(
        () =>
            (sidebarItems ?? [])
                .filter((item) => !item.disabled && item.id !== 'Collections' && item.route)
                .map((item) => ({ ...item, label: labels[item.id] ?? item.label })),
        [sidebarItems, labels],
    );

    return (
        <div className={styles.container} id="mobile-sidebar" ref={containerRef}>
            <Group grow id="global-search-container" style={{ flexShrink: 0 }}>
                <ActionBar />
            </Group>
            <ScrollArea allowDragScroll className={styles.scrollArea}>
                <Accordion
                    classNames={{
                        content: styles.accordionContent,
                        control: styles.accordionControl,
                        item: styles.accordionItem,
                        root: styles.accordionRoot,
                    }}
                    defaultValue={['library', 'playlists']}
                    multiple
                    transitionDuration={150}
                >
                    <Accordion.Item value="library">
                        <Accordion.Control>
                            <Text fw={600} variant="secondary">
                                {t('page.sidebar.myLibrary')}
                            </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                            {sidebarItemsWithRoute.map((item) => {
                                return (
                                    <SidebarItem key={`sidebar-${item.route}`} to={item.route}>
                                        <Group gap="sm">
                                            <SidebarIcon route={item.route} />
                                            {item.label}
                                        </Group>
                                    </SidebarItem>
                                );
                            })}
                        </Accordion.Panel>
                    </Accordion.Item>
                    {sidebarBottomSection === 'playlists' && <MobileSidebarPlaylistSection />}
                    {sidebarBottomSection === 'favoriteAlbums' && <SidebarFavoriteAlbumsList />}
                </Accordion>
            </ScrollArea>
        </div>
    );
};
