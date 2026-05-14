import clsx from 'clsx';
import { useMemo } from 'react';
import { generatePath, Link } from 'react-router';

import styles from './album-column.module.css';

import {
    ColumnNullFallback,
    ColumnSkeletonVariable,
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { useShowFilesystemNameForAlbums } from '/@/renderer/store/settings.store';

const preloadAlbumDetail = () => preloadRoute(AppRoute.LIBRARY_ALBUMS_DETAIL);
import { Text } from '/@/shared/components/text/text';
import { Song } from '/@/shared/types/domain-types';

const albumFolderNameFromSongPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length < 2) return null;
    return segments[segments.length - 2] ?? null;
};

const AlbumColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: null | string | undefined = rowItem?.[props.columns[props.columnIndex].id];

    const song = rowItem as Song | undefined;
    const albumId = song?.albumId;
    const useFsName = useShowFilesystemNameForAlbums();

    const albumPath = useMemo(() => {
        if (!albumId) return null;
        return generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId });
    }, [albumId]);

    const displayValue = useFsName
        ? (albumFolderNameFromSongPath(song?.path) ?? (typeof row === 'string' ? row : null))
        : typeof row === 'string'
          ? row
          : null;

    if (typeof row === 'string') {
        if (albumId && albumPath) {
            return (
                <TableColumnContainer {...props}>
                    <div
                        className={clsx(styles.albumContainer, {
                            [styles.compact]: props.size === 'compact',
                            [styles.large]: props.size === 'large',
                        })}
                    >
                        <Text
                            className={styles.albumLink}
                            component={Link}
                            isLink
                            isMuted
                            isNoSelect
                            onFocus={preloadAlbumDetail}
                            onMouseEnter={preloadAlbumDetail}
                            state={{ item: song }}
                            to={albumPath}
                        >
                            {displayValue}
                        </Text>
                    </div>
                </TableColumnContainer>
            );
        }

        return (
            <TableColumnContainer {...props}>
                <Text
                    className={clsx(styles.albumContainer, {
                        [styles.compact]: props.size === 'compact',
                        [styles.large]: props.size === 'large',
                    })}
                    isMuted
                    isNoSelect
                >
                    {displayValue}
                </Text>
            </TableColumnContainer>
        );
    }

    if (rowItem != null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonVariable {...props} />;
};

export { AlbumColumn };
