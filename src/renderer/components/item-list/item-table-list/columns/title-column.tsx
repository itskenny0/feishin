import clsx from 'clsx';
import { useMemo } from 'react';
import { Link } from 'react-router';

import styles from './title-column.module.css';

import { getTitlePath } from '/@/renderer/components/item-list/helpers/get-title-path';
import {
    ColumnNullFallback,
    ColumnSkeletonVariable,
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { useIsActiveRow } from '/@/renderer/components/item-list/item-table-list/item-table-list-context';
import {
    useShowFilesystemNameForAlbums,
    useShowFilesystemNameForFolders,
} from '/@/renderer/store/settings.store';
import { ExplicitIndicator } from '/@/shared/components/explicit-indicator/explicit-indicator';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';

const filesystemNameFromPath = (path: string): string => {
    const segments = path.split(/[/\\]/).filter(Boolean);
    return segments[segments.length - 1] || '';
};

const useFilesystemDisplayName = (item: any, fallback: string): string => {
    const useFsForFolders = useShowFilesystemNameForFolders();
    const useFsForAlbums = useShowFilesystemNameForAlbums();
    if (!item?.path) return fallback;
    const apply =
        (item._itemType === LibraryItem.FOLDER && useFsForFolders) ||
        (item._itemType === LibraryItem.ALBUM && useFsForAlbums);
    if (!apply) return fallback;
    return filesystemNameFromPath(item.path) || fallback;
};

const TitleColumnBase = (props: ItemTableListInnerColumn) => {
    const { itemType } = props;

    switch (itemType) {
        case LibraryItem.FOLDER:
        case LibraryItem.PLAYLIST_SONG:
        case LibraryItem.QUEUE_SONG:
        case LibraryItem.SONG:
            return <QueueSongTitleColumn {...props} />;
        default:
            return <DefaultTitleColumn {...props} />;
    }
};

export const TitleColumn = TitleColumnBase;

function DefaultTitleColumn(props: ItemTableListInnerColumn) {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: string | undefined = rowItem?.[props.columns[props.columnIndex].id];

    const path = useMemo(() => {
        if (typeof row !== 'string' || !rowItem || !(rowItem as any).id) return undefined;
        return getTitlePath(props.itemType, (rowItem as any).id as string);
    }, [props.itemType, row, rowItem]);

    const displayName = useFilesystemDisplayName(rowItem, typeof row === 'string' ? row : '');

    if (typeof row === 'string') {
        const item = rowItem as any;

        const titleLinkProps = path
            ? {
                  component: Link,
                  isLink: true,
                  state: { item },
                  to: path,
              }
            : {};

        return (
            <TableColumnContainer {...props}>
                <Text
                    className={clsx({
                        [styles.compact]: props.size === 'compact',
                        [styles.large]: props.size === 'large',
                        [styles.nameContainer]: true,
                    })}
                    isNoSelect
                    {...titleLinkProps}
                >
                    <ExplicitIndicator explicitStatus={item?.explicitStatus} />
                    {displayName}
                </Text>
            </TableColumnContainer>
        );
    }

    if (row === null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonVariable {...props} />;
}

function QueueSongTitleColumn(props: ItemTableListInnerColumn) {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: string | undefined = rowItem?.[props.columns[props.columnIndex].id];

    const song = rowItem as QueueSong;
    const isActive = useIsActiveRow(song?.id, song?._uniqueId);

    const path = useMemo(() => {
        if (typeof row !== 'string' || !rowItem || !(rowItem as any).id) return undefined;
        return getTitlePath(props.itemType, (rowItem as any).id as string);
    }, [props.itemType, row, rowItem]);

    const displayName = useFilesystemDisplayName(rowItem, typeof row === 'string' ? row : '');

    if (typeof row === 'string') {
        const item = rowItem as any;

        const titleLinkProps = path
            ? {
                  component: Link,
                  isLink: true,
                  state: { item },
                  to: path,
              }
            : {};

        return (
            <TableColumnContainer {...props}>
                <Text
                    className={clsx({
                        [styles.active]: isActive,
                        [styles.compact]: props.size === 'compact',
                        [styles.large]: props.size === 'large',
                        [styles.nameContainer]: true,
                    })}
                    isNoSelect
                    {...titleLinkProps}
                >
                    <ExplicitIndicator explicitStatus={song?.explicitStatus} />
                    {displayName}
                    {song?.trackSubtitle && props.itemType !== LibraryItem.QUEUE_SONG && (
                        <Text
                            className={clsx({
                                [styles.active]: isActive,
                            })}
                            component="span"
                            isMuted
                            size="sm"
                        >
                            {' ('}
                            {song.trackSubtitle}
                            {')'}
                        </Text>
                    )}
                </Text>
            </TableColumnContainer>
        );
    }

    if (row === null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonVariable {...props} />;
}
