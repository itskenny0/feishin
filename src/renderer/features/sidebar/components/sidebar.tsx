import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { MouseEvent, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import styles from './sidebar.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { ActionBar } from '/@/renderer/features/sidebar/components/action-bar';
import { SidebarCollectionList } from '/@/renderer/features/sidebar/components/sidebar-collection-list';
import { SidebarFavoriteAlbumsList } from '/@/renderer/features/sidebar/components/sidebar-favorite-albums-list';
import { SidebarIcon } from '/@/renderer/features/sidebar/components/sidebar-icon';
import { SidebarItem } from '/@/renderer/features/sidebar/components/sidebar-item';
import {
    SidebarPlaylistList,
    SidebarSharedPlaylistList,
} from '/@/renderer/features/sidebar/components/sidebar-playlist-list';
import {
    useAppStore,
    useAppStoreActions,
    useBlurExplicitImages,
    useFullScreenPlayerStore,
    usePlayerSong,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import {
    SidebarItemType,
    useSidebarBottomSection,
    useSidebarItems,
    useWindowSettings,
} from '/@/renderer/store/settings.store';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { ImageUnloader } from '/@/shared/components/image/image';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { useDisclosure } from '/@/shared/hooks/use-disclosure';
import { ExplicitStatus, LibraryItem } from '/@/shared/types/domain-types';
import { Platform } from '/@/shared/types/types';

export const Sidebar = () => {
    const { t } = useTranslation();

    const sidebarBottomSection = useSidebarBottomSection();

    const translatedSidebarItemMap = useMemo(
        () => ({
            Albums: t('page.sidebar.albums'),
            Artists: t('page.sidebar.albumArtists'),
            'Artists-all': t('page.sidebar.artists'),
            Collections: t('page.sidebar.collections'),
            Favorites: t('page.sidebar.favorites'),
            Folders: t('page.sidebar.folders'),
            Genres: t('page.sidebar.genres'),
            Home: t('page.sidebar.home'),
            'Now Playing': t('page.sidebar.nowPlaying'),
            Playlists: t('page.sidebar.playlists'),
            Radio: t('page.sidebar.radio'),
            Search: t('page.sidebar.search'),
            Settings: t('page.sidebar.settings'),
            Tracks: t('page.sidebar.tracks'),
        }),
        [t],
    );

    const sidebarItems = useSidebarItems();
    const { windowBarStyle } = useWindowSettings();
    const sidebarImageEnabled = useAppStore((state) => state.sidebar.image);
    const sidebarExpandedFromStore = useAppStore((state) => state.sidebar.expanded);
    const { setSideBar } = useAppStoreActions();
    const showImage = sidebarImageEnabled;

    // Persist accordion open/close across launches. Empty store value
    // (initial state for existing users) is treated as "show defaults" so
    // the experience matches what they had before. After any user
    // interaction the explicit list is persisted.
    const SIDEBAR_DEFAULT_OPEN = useMemo(
        () => ['library', 'collections', 'playlists', 'favorite-albums'],
        [],
    );
    const sidebarExpanded =
        sidebarExpandedFromStore.length > 0 ? sidebarExpandedFromStore : SIDEBAR_DEFAULT_OPEN;
    const handleAccordionChange = (val: null | string | string[]) => {
        // Mantine's multi-accordion onChange gives us the new open list.
        // Store a sentinel so 'all collapsed' is distinguishable from
        // 'never interacted with the accordion' (the latter wants the
        // defaults). The simplest sentinel is a single non-existent value;
        // any non-empty array means "the user's choice — respect it".
        const next = Array.isArray(val) ? val : val ? [val] : [];
        setSideBar({ expanded: next.length === 0 ? ['__collapsed__'] : next });
    };

    const sidebarItemsWithRoute: SidebarItemType[] = useMemo(() => {
        if (!sidebarItems) return [];

        const items = sidebarItems
            .filter((item) => !item.disabled)
            .map((item) => ({
                ...item,
                label:
                    translatedSidebarItemMap[item.id as keyof typeof translatedSidebarItemMap] ??
                    item.label,
            }));

        return items;
    }, [sidebarItems, translatedSidebarItemMap]);

    /* Library accordion: only items with a route (exclude Collections section) */
    const libraryItemsWithRoute = useMemo(
        () => sidebarItemsWithRoute.filter((item) => item.id !== 'Collections' && item.route),
        [sidebarItemsWithRoute],
    );

    const isCustomWindowBar =
        windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS;

    return (
        <div
            aria-label={t('common.sidebar', { defaultValue: 'Sidebar navigation' })}
            className={clsx(styles.container, {
                [styles.customBar]: isCustomWindowBar,
            })}
            id="left-sidebar"
            role="navigation"
        >
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
                    multiple
                    onChange={handleAccordionChange}
                    value={
                        (sidebarExpanded.includes('__collapsed__')
                            ? []
                            : sidebarExpanded) as unknown as string
                    }
                >
                    <Accordion.Item value="library">
                        <Accordion.Control>
                            <Text fw={500} variant="secondary">
                                {t('page.sidebar.myLibrary')}
                            </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                            {libraryItemsWithRoute.map((item) => {
                                return (
                                    <SidebarItem key={`sidebar-${item.route}`} to={item.route}>
                                        <Group gap="md">
                                            <SidebarIcon route={item.route} />
                                            {item.label}
                                        </Group>
                                    </SidebarItem>
                                );
                            })}
                        </Accordion.Panel>
                    </Accordion.Item>
                    <SidebarCollectionList />
                    {sidebarBottomSection === 'playlists' && (
                        <>
                            <SidebarPlaylistList />
                            <SidebarSharedPlaylistList />
                        </>
                    )}
                    {sidebarBottomSection === 'favoriteAlbums' && <SidebarFavoriteAlbumsList />}
                </Accordion>
            </ScrollArea>
            <AnimatePresence initial={false} mode="popLayout">
                {showImage && <SidebarImage />}
            </AnimatePresence>
        </div>
    );
};

const SidebarImage = () => {
    const { t } = useTranslation();
    const { setSideBar } = useAppStoreActions();
    const currentSong = usePlayerSong();
    const isRadioActive = useIsRadioActive();
    const { currentStationArt, isPlaying: isRadioPlaying } = useRadioPlayer();
    const blurExplicitImages = useBlurExplicitImages();

    const imageUrl = useItemImageUrl({
        id: currentSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        serverId: currentSong?._serverId,
        type: 'sidebar',
    });

    const radioImageUrl = useItemImageUrl({
        id: isRadioActive ? currentStationArt?.imageId || undefined : undefined,
        imageUrl: isRadioActive ? currentStationArt?.imageUrl || undefined : undefined,
        itemType: LibraryItem.RADIO_STATION,
        serverId: isRadioActive ? currentStationArt?.serverId : undefined,
        type: 'sidebar',
    });

    // Request the full-screen-sized cover for the zoom lightbox so it doesn't
    // pixelate when scaled to viewport height. The sidebar variant (~400px)
    // is fine for the small thumbnail but stretches badly at viewport size.
    const fullResImageUrl = useItemImageUrl({
        id: currentSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        serverId: currentSong?._serverId,
        type: 'fullScreenPlayer',
    });
    const fullResRadioImageUrl = useItemImageUrl({
        id: isRadioActive ? currentStationArt?.imageId || undefined : undefined,
        imageUrl: isRadioActive ? currentStationArt?.imageUrl || undefined : undefined,
        itemType: LibraryItem.RADIO_STATION,
        serverId: isRadioActive ? currentStationArt?.serverId : undefined,
        type: 'fullScreenPlayer',
    });

    const isPlayingRadio = isRadioActive && isRadioPlaying;
    const isSongDefined = Boolean(currentSong?.id);

    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const { expanded: isFullScreenPlayerExpanded } = useFullScreenPlayerStore();
    const expandFullScreenPlayer = () => {
        setFullScreenPlayerStore({ expanded: !isFullScreenPlayerExpanded });
    };

    // Zoom lightbox state — separate from the full-screen player so the user
    // can briefly inspect cover art without opening the whole player UI.
    const [isZoomOpen, zoomHandlers] = useDisclosure(false);
    const zoomImageUrl = isRadioActive
        ? fullResRadioImageUrl || radioImageUrl
        : fullResImageUrl || imageUrl;

    const handleToggleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        if (!currentSong || isPlayingRadio) {
            return;
        }

        if (isSongDefined && !isFullScreenPlayerExpanded) {
            ContextMenuController.call({
                cmd: { items: [currentSong!], type: LibraryItem.SONG },
                event: e,
            });
        }
    };

    return (
        <motion.div
            animate={{ opacity: 1, y: 0 }}
            className={styles.imageContainer}
            exit={{ opacity: 0, y: 200 }}
            initial={{ opacity: 0, y: 200 }}
            key="sidebar-image"
            onClick={expandFullScreenPlayer}
            onContextMenu={handleToggleContextMenu}
            role="button"
            style={{ aspectRatio: 1 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
            <Tooltip label={t('player.toggleFullscreenPlayer')}>
                {isRadioActive && radioImageUrl ? (
                    <img className={styles.sidebarImage} loading="eager" src={radioImageUrl} />
                ) : isRadioActive ? (
                    <Center
                        className={styles.sidebarImage}
                        style={{
                            background: 'var(--theme-colors-surface)',
                            borderRadius: 'var(--theme-card-default-radius)',
                            height: '100%',
                            width: '100%',
                        }}
                    >
                        <Icon color="muted" icon="radio" size="40%" />
                    </Center>
                ) : imageUrl ? (
                    <img
                        className={clsx(styles.sidebarImage, {
                            [styles.censored]:
                                currentSong?.explicitStatus === ExplicitStatus.EXPLICIT &&
                                blurExplicitImages,
                        })}
                        loading="eager"
                        src={imageUrl}
                    />
                ) : (
                    <ImageUnloader icon="emptySongImage" />
                )}
            </Tooltip>
            {zoomImageUrl && (
                <ActionIcon
                    icon="expand"
                    iconProps={{
                        size: 'lg',
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        zoomHandlers.open();
                    }}
                    opacity={0.8}
                    radius="md"
                    style={{
                        cursor: 'default',
                        position: 'absolute',
                        right: '3.5rem',
                        top: '1rem',
                    }}
                    tooltip={{
                        label: t('common.zoom'),
                        openDelay: 500,
                    }}
                />
            )}
            <ActionIcon
                icon="arrowDownS"
                iconProps={{
                    size: 'lg',
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    setSideBar({ image: false });
                }}
                opacity={0.8}
                radius="md"
                style={{
                    cursor: 'default',
                    position: 'absolute',
                    right: '1rem',
                    top: '1rem',
                }}
                tooltip={{
                    label: t('common.collapse'),
                    openDelay: 500,
                }}
            />
            <ImageZoomLightbox
                imageUrl={zoomImageUrl}
                onClose={zoomHandlers.close}
                opened={isZoomOpen}
            />
        </motion.div>
    );
};

/**
 * Full-window lightbox for the currently playing album art. Renders into a
 * portal so the sidebar's overflow:hidden doesn't clip it, and bails out via
 * Escape and backdrop click. Image scales to viewport height with an aspect-
 * preserving max-width.
 */
const ImageZoomLightbox = ({
    imageUrl,
    onClose,
    opened,
}: {
    imageUrl: null | string | undefined;
    onClose: () => void;
    opened: boolean;
}) => {
    const { t } = useTranslation();

    useEffect(() => {
        if (!opened) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [opened, onClose]);

    if (!opened || !imageUrl) return null;

    return createPortal(
        <div className={styles.zoomOverlay} onClick={onClose} role="dialog">
            <img
                alt=""
                className={styles.zoomImage}
                onClick={(e) => e.stopPropagation()}
                src={imageUrl}
            />
            <ActionIcon
                aria-label={t('common.close')}
                className={styles.zoomCloseButton}
                icon="x"
                iconProps={{ size: 'xl' }}
                onClick={onClose}
                radius="md"
                tooltip={{ label: t('common.close'), openDelay: 500 }}
            />
        </div>,
        document.body,
    );
};
