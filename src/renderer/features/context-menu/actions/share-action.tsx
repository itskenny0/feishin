import { openContextModal } from '@mantine/modals';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useCurrentServer } from '/@/renderer/store';
import { hasFeature } from '/@/shared/api/utils';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';

interface ShareActionProps {
    ids: string[];
    itemType: LibraryItem;
}

export const ShareAction = ({ ids, itemType }: ShareActionProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();

    const resourceType = useMemo(() => {
        switch (itemType) {
            case LibraryItem.ALBUM:
                return 'album';
            case LibraryItem.ALBUM_ARTIST:
                return 'albumArtist';
            case LibraryItem.FOLDER:
                return 'folder';
            case LibraryItem.PLAYLIST:
                return 'playlist';
            case LibraryItem.SONG:
                return 'song';
            default:
                return 'song';
        }
    }, [itemType]);

    const onSelect = useCallback(() => {
        openContextModal({
            innerProps: {
                itemIds: ids,
                resourceType,
            },
            modal: 'shareItem',
            title: t('page.contextMenu.shareItem'),
        });
    }, [ids, resourceType, t]);

    // Only Navidrome implements sharing; elsewhere the request fails.
    if (!hasFeature(server, ServerFeature.SHARING_ALBUM_SONG)) return null;

    return (
        <ContextMenu.Item leftIcon="share" onSelect={onSelect}>
            {t('page.contextMenu.shareItem')}
        </ContextMenu.Item>
    );
};
