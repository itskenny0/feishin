import { useTranslation } from 'react-i18next';

import styles from './context-menu-preview.module.css';

import { CachedImage } from '/@/renderer/cache';
import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import {
    useShowFilesystemNameForAlbums,
    useShowFilesystemNameForFolders,
} from '/@/renderer/store/settings.store';
import { Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';

interface ContextMenuPreviewProps {
    items: unknown[];
    itemType?: LibraryItem;
}

const getItemMetadataName = (item: unknown): string => {
    if (item && typeof item === 'object') {
        if ('name' in item && typeof item.name === 'string') {
            return item.name;
        }
        if ('title' in item && typeof item.title === 'string') {
            return item.title;
        }
    }
    return 'Item';
};

const getItemPath = (item: unknown): null | string => {
    if (
        item &&
        typeof item === 'object' &&
        'path' in item &&
        typeof item.path === 'string' &&
        item.path
    ) {
        return item.path;
    }
    return null;
};

const filesystemNameFromPath = (path: string, isFolderItem: boolean): null | string => {
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) return null;
    // Songs end with the audio filename, so the containing folder is the
    // segment before that. Albums and folders already point at the folder.
    if (isFolderItem) {
        return segments[segments.length - 1];
    }
    return segments[segments.length - 2] ?? null;
};

const getItemImage = (item: unknown): null | string => {
    if (item && typeof item === 'object') {
        if ('imageId' in item && typeof item.imageId === 'string') {
            return item.imageId;
        }

        if ('imageUrl' in item && typeof item.imageUrl === 'string') {
            return item.imageUrl;
        }
    }
    return null;
};

const getItemId = (item: unknown): null | string => {
    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
        return item.id;
    }
    return null;
};

export const ContextMenuPreview = ({ items, itemType }: ContextMenuPreviewProps) => {
    const { t } = useTranslation();
    const useFsForAlbums = useShowFilesystemNameForAlbums();
    const useFsForFolders = useShowFilesystemNameForFolders();
    const itemCount = items.length;
    const firstItem = items[0];

    const metadataName = firstItem ? getItemMetadataName(firstItem) : 'Item';
    const path = firstItem ? getItemPath(firstItem) : null;
    const useFsName =
        (itemType === LibraryItem.ALBUM && useFsForAlbums) ||
        (itemType === LibraryItem.FOLDER && useFsForFolders);
    const isFolderItem = itemType === LibraryItem.ALBUM || itemType === LibraryItem.FOLDER;
    const filesystemName = useFsName && path ? filesystemNameFromPath(path, isFolderItem) : null;
    const itemName = filesystemName || metadataName;

    const itemImage = firstItem ? getItemImage(firstItem) : null;
    const itemId = firstItem ? getItemId(firstItem) : null;
    const isMultiple = itemCount > 1;

    const imageUrl = useItemImageUrl({
        id: (firstItem as { imageId?: string })?.imageId,
        itemType: itemType || LibraryItem.SONG,
        serverId: (firstItem as { _serverId?: string })?._serverId,
        type: 'table',
    });

    if (itemCount === 0) {
        return null;
    }

    return (
        <div className={styles.container}>
            <div className={styles.divider} />
            <div className={styles.preview}>
                <div className={styles.content}>
                    {itemImage ? (
                        <div className={styles.imageContainer}>
                            {imageUrl && itemId ? (
                                <CachedImage
                                    alt={itemName}
                                    className={styles.image}
                                    itemId={itemId}
                                    size={96}
                                    src={imageUrl}
                                />
                            ) : (
                                <img alt={itemName} className={styles.image} src={imageUrl ?? ''} />
                            )}
                            <div className={styles.imageOverlay} />
                        </div>
                    ) : (
                        <div className={styles.iconContainer}>
                            {itemType === LibraryItem.ALBUM && <Icon icon="album" size="md" />}
                            {itemType === LibraryItem.SONG && <Icon icon="itemSong" size="md" />}
                            {itemType === LibraryItem.ALBUM_ARTIST && (
                                <Icon icon="artist" size="md" />
                            )}
                            {itemType === LibraryItem.ARTIST && <Icon icon="artist" size="md" />}
                            {itemType === LibraryItem.PLAYLIST && (
                                <Icon icon="playlist" size="md" />
                            )}
                            {itemType === LibraryItem.GENRE && <Icon icon="genre" size="md" />}
                            {itemType === LibraryItem.FOLDER && <Icon icon="folder" size="md" />}
                            {!itemType && <Icon icon="library" size="md" />}
                        </div>
                    )}
                    <div className={styles.textContainer}>
                        <Text className={styles.name} isNoSelect>
                            {itemName}
                        </Text>
                        {isMultiple && (
                            <Text className={styles.count} isNoSelect>
                                +{t('common.itemsMore', { count: itemCount - 1 })}
                            </Text>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

ContextMenuPreview.displayName = 'ContextMenuPreview';
