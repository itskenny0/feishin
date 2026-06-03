import { useMemo } from 'react';

import { AddToPlaylistAction } from '/@/renderer/features/context-menu/actions/add-to-playlist-action';
import { OfflineDownloadAction } from '/@/renderer/features/context-menu/actions/offline-download-action';
import { PlayAction } from '/@/renderer/features/context-menu/actions/play-action';
import { ContextMenuPreview } from '/@/renderer/features/context-menu/components/context-menu-preview';
import { MenuContent } from '/@/renderer/features/context-menu/components/menu-content';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Genre, LibraryItem } from '/@/shared/types/domain-types';

interface GenreContextMenuProps {
    items: Genre[];
    type: LibraryItem.GENRE;
}

export const GenreContextMenu = ({ items, type }: GenreContextMenuProps) => {
    const { ids } = useMemo(() => {
        const ids = items.map((item) => item.id);
        return { ids };
    }, [items]);

    return (
        <MenuContent bottomStickyContent={<ContextMenuPreview items={items} itemType={type} />}>
            <PlayAction ids={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <AddToPlaylistAction items={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <OfflineDownloadAction items={items} itemType={LibraryItem.GENRE} />
        </MenuContent>
    );
};
