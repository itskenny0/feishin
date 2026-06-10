import { useMemo } from 'react';

import { AddToPlaylistAction } from '/@/renderer/features/context-menu/actions/add-to-playlist-action';
import { DownloadAction } from '/@/renderer/features/context-menu/actions/download-action';
import { GetInfoAction } from '/@/renderer/features/context-menu/actions/get-info-action';
import { GoToAction } from '/@/renderer/features/context-menu/actions/go-to-action';
import { OfflineDownloadAction } from '/@/renderer/features/context-menu/actions/offline-download-action';
import { PinAction } from '/@/renderer/features/context-menu/actions/pin-action';
import { PlayAction } from '/@/renderer/features/context-menu/actions/play-action';
import { PlayAlbumRadioAction } from '/@/renderer/features/context-menu/actions/play-album-radio-action';
import { RefreshMetadataAction } from '/@/renderer/features/context-menu/actions/refresh-metadata-action';
import { SetFavoriteAction } from '/@/renderer/features/context-menu/actions/set-favorite-action';
import { SetRatingAction } from '/@/renderer/features/context-menu/actions/set-rating-action';
import { ShareAction } from '/@/renderer/features/context-menu/actions/share-action';
import { ContextMenuPreview } from '/@/renderer/features/context-menu/components/context-menu-preview';
import { MenuContent } from '/@/renderer/features/context-menu/components/menu-content';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Album, LibraryItem } from '/@/shared/types/domain-types';

interface AlbumContextMenuProps {
    items: Album[];
    type: LibraryItem.ALBUM;
}

export const AlbumContextMenu = ({ items, type }: AlbumContextMenuProps) => {
    const { ids } = useMemo(() => {
        const ids = items.map((item) => item.id);
        return { ids };
    }, [items]);

    return (
        <MenuContent bottomStickyContent={<ContextMenuPreview items={items} itemType={type} />}>
            <PlayAction ids={ids} itemType={LibraryItem.ALBUM} />
            <PlayAlbumRadioAction album={items[0]} disabled={items.length > 1} />
            <ContextMenu.Divider />
            <AddToPlaylistAction items={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <SetFavoriteAction ids={ids} itemType={LibraryItem.ALBUM} />
            <SetRatingAction ids={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <OfflineDownloadAction items={items} itemType={LibraryItem.ALBUM} />
            <DownloadAction ids={ids} />
            <ShareAction ids={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <PinAction items={items} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <GoToAction items={items} />
            <ContextMenu.Divider />
            <RefreshMetadataAction disabled={items.length === 0} ids={ids} />
            <GetInfoAction disabled={items.length === 0} items={items} />
        </MenuContent>
    );
};
