import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { memo, MouseEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './sidebar-playlist-list.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    LONG_PRESS_PLAY_BEHAVIOR,
    PlayTooltip,
} from '/@/renderer/features/shared/components/play-button-group';
import { usePlayButtonClick } from '/@/renderer/features/shared/hooks/use-play-button-click';
import { prefetchAlbumDetail, preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer } from '/@/renderer/store';
import {
    usePrefetchSidebarAlbums,
    useShowFilesystemNameForAlbums,
} from '/@/renderer/store/settings.store';
import { Accordion } from '/@/shared/components/accordion/accordion';
import { ActionIcon, ActionIconGroup } from '/@/shared/components/action-icon/action-icon';
import { ButtonProps } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Image } from '/@/shared/components/image/image';
import { Text } from '/@/shared/components/text/text';
import { Album, AlbumListSort, LibraryItem, SortOrder } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

const filesystemNameFromAlbumPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) return null;
    return segments[segments.length - 1];
};

interface AlbumRowButtonProps extends Omit<ButtonProps, 'onContextMenu' | 'onPlay'> {
    item: Album;
    name: string;
    onContextMenu: (e: MouseEvent<HTMLAnchorElement>, item: Album) => void;
}

const AlbumRowButton = memo(({ item, name, onContextMenu }: AlbumRowButtonProps) => {
    const url = {
        pathname: generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: item.id }),
        state: { item },
    };
    const [isHovered, setIsHovered] = useState(false);

    const player = usePlayer();
    const handlePlay = useCallback(
        (id: string, type: Play) => {
            player.addToQueueByFetch(item._serverId, [id], LibraryItem.ALBUM, type);
        },
        [player, item._serverId],
    );

    const imageUrl = useItemImageUrl({
        id: item.imageId || undefined,
        itemType: LibraryItem.ALBUM,
        type: 'table',
    });

    // On hover, warm the album-detail route chunk and prefetch the detail
    // query so the click resolves from cache without a loading flash. Both
    // calls dedupe internally (preloadRoute once per session, prefetchQuery
    // by queryKey), so repeated hovers are cheap.
    const handleHoverPreload = useCallback(() => {
        setIsHovered(true);
        preloadRoute(url.pathname);
        prefetchAlbumDetail(item.id);
    }, [url.pathname, item.id]);

    return (
        <Link
            className={clsx(styles.row, {
                [styles.rowHover]: isHovered,
            })}
            onContextMenu={(e: MouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
                onContextMenu(e, item);
            }}
            onFocus={handleHoverPreload}
            onMouseEnter={handleHoverPreload}
            onMouseLeave={() => setIsHovered(false)}
            to={url}
        >
            <div className={styles.rowGroup}>
                <Image containerClassName={styles.imageContainer} src={imageUrl} />
                <div className={styles.metadata}>
                    <Text className={styles.name} fw={500} size="md">
                        {name}
                    </Text>
                    <div className={styles.metadataGroup}>
                        {item.albumArtistName && (
                            <div className={styles.metadataGroupItem}>
                                <Icon color="muted" icon="artist" size="sm" />
                                <Text isMuted size="sm">
                                    {item.albumArtistName}
                                </Text>
                            </div>
                        )}
                        {item.songCount != null && (
                            <div
                                className={clsx(
                                    styles.metadataGroupItem,
                                    styles.metadataGroupItemNoShrink,
                                )}
                            >
                                <Icon color="muted" icon="itemSong" size="sm" />
                                <Text isMuted size="sm">
                                    {item.songCount}
                                </Text>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {isHovered && <RowControls id={item.id} onPlay={handlePlay} />}
        </Link>
    );
});

AlbumRowButton.displayName = 'AlbumRowButton';

const RowControls = ({
    id,
    onPlay,
}: {
    id: string;
    onPlay: (id: string, playType: Play) => void;
}) => {
    const handlePlayNext = usePlayButtonClick({
        onClick: () => onPlay(id, Play.NEXT),
        onLongPress: () => onPlay(id, LONG_PRESS_PLAY_BEHAVIOR[Play.NEXT]),
    });
    const handlePlayNow = usePlayButtonClick({
        onClick: () => onPlay(id, Play.NOW),
        onLongPress: () => onPlay(id, LONG_PRESS_PLAY_BEHAVIOR[Play.NOW]),
    });
    const handlePlayLast = usePlayButtonClick({
        onClick: () => onPlay(id, Play.LAST),
        onLongPress: () => onPlay(id, LONG_PRESS_PLAY_BEHAVIOR[Play.LAST]),
    });

    return (
        <ActionIconGroup className={styles.controls}>
            <PlayTooltip type={Play.NOW}>
                <ActionIcon
                    icon="mediaPlay"
                    iconProps={{ size: 'md' }}
                    size="xs"
                    variant="subtle"
                    {...handlePlayNow.handlers}
                    {...handlePlayNow.props}
                />
            </PlayTooltip>
            <PlayTooltip type={Play.NEXT}>
                <ActionIcon
                    icon="mediaPlayNext"
                    iconProps={{ size: 'md' }}
                    size="xs"
                    variant="subtle"
                    {...handlePlayNext.handlers}
                    {...handlePlayNext.props}
                />
            </PlayTooltip>
            <PlayTooltip type={Play.LAST}>
                <ActionIcon
                    icon="mediaPlayLast"
                    iconProps={{ size: 'md' }}
                    size="xs"
                    variant="subtle"
                    {...handlePlayLast.handlers}
                    {...handlePlayLast.props}
                />
            </PlayTooltip>
        </ActionIconGroup>
    );
};

export const SidebarFavoriteAlbumsList = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const useFsName = useShowFilesystemNameForAlbums();
    const prefetchEnabled = usePrefetchSidebarAlbums();
    const queryClient = useQueryClient();

    const albumsQuery = useQuery(
        albumQueries.list({
            query: {
                favorite: true,
                sortBy: AlbumListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
            serverId: server?.id,
        }),
    );

    const handleContextMenu = useCallback((e: MouseEvent<HTMLAnchorElement>, album: Album) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuController.call({
            cmd: { items: [album], type: LibraryItem.ALBUM },
            event: e,
        });
    }, []);

    const items = useMemo(() => albumsQuery.data?.items ?? [], [albumsQuery.data]);

    // Background-prefetch each visible album's detail so clicking a row
    // resolves from cache instantly. tanstack-query dedupes against any
    // existing fetch and respects the configured staleTime, so this is a
    // no-op for albums we've recently loaded. Defer with rIC so it never
    // competes with whatever the user is doing right now, and throttle
    // concurrency to a small window so a sidebar with dozens of favorited
    // albums doesn't flood the server with simultaneous detail requests
    // (each detail call hits two Jellyfin endpoints).
    useEffect(() => {
        if (!prefetchEnabled || !server?.id || items.length === 0) return;

        const win = window as typeof window & {
            cancelIdleCallback?: (id: number) => void;
            requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
        };
        const schedule = win.requestIdleCallback ?? ((cb) => window.setTimeout(cb, 200));
        const cancel = win.cancelIdleCallback ?? window.clearTimeout;

        let cancelled = false;
        const handle = schedule(async () => {
            const concurrency = 3;
            let cursor = 0;
            const worker = async () => {
                while (!cancelled) {
                    const next = cursor++;
                    if (next >= items.length) return;
                    const album = items[next];
                    try {
                        await queryClient.prefetchQuery(
                            albumQueries.detail({
                                query: { id: album.id },
                                serverId: server.id,
                            }),
                        );
                    } catch {
                        // ignore individual failures; the user-driven fetch
                        // will retry on click.
                    }
                }
            };
            await Promise.all(Array.from({ length: concurrency }, worker));
        });

        return () => {
            cancelled = true;
            cancel(handle as number);
        };
    }, [items, prefetchEnabled, queryClient, server?.id]);

    return (
        <Accordion.Item value="favorite-albums">
            <Accordion.Control component="div" role="button" style={{ userSelect: 'none' }}>
                <Group justify="space-between" pr="var(--theme-spacing-md)">
                    <Text fw={500}>
                        {t('page.sidebar.favoriteAlbums', { postProcess: 'titleCase' })}
                    </Text>
                    <Group gap="xs">
                        <ActionIcon
                            component={Link}
                            icon="list"
                            iconProps={{ size: 'lg' }}
                            onClick={(e) => e.stopPropagation()}
                            size="xs"
                            to={`${AppRoute.LIBRARY_ALBUMS}?favorite=true`}
                            tooltip={{
                                label: t('action.viewAlbums', {
                                    postProcess: 'sentenceCase',
                                }),
                                openDelay: 400,
                            }}
                            variant="subtle"
                        />
                    </Group>
                </Group>
            </Accordion.Control>
            <Accordion.Panel>
                {items.map((item) => {
                    const fsName = useFsName ? filesystemNameFromAlbumPath(item.path) : null;
                    return (
                        <AlbumRowButton
                            item={item}
                            key={item.id}
                            name={fsName || item.name}
                            onContextMenu={handleContextMenu}
                        />
                    );
                })}
            </Accordion.Panel>
        </Accordion.Item>
    );
};
