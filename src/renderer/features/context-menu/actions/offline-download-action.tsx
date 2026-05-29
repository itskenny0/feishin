// "Download for offline" context-menu action. Available on every entity the
// offline engine can enumerate (album / artist / album-artist / genre /
// playlist / song). Hidden entirely when offline downloads aren't available
// (local cache disabled or IndexedDB missing). Supports multi-select — every
// selected entity is queued for download.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
    libraryItemToOfflineEntityType,
    OfflineDownloadEntity,
    useOfflineDownload,
} from '/@/renderer/features/context-menu/hooks/use-offline-download';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { LibraryItem } from '/@/shared/types/domain-types';

interface OfflineDownloadActionProps {
    // Minimal shape every domain entity in a context menu shares.
    items: { id: string; name: string }[];
    itemType: LibraryItem;
}

export const OfflineDownloadAction = ({ items, itemType }: OfflineDownloadActionProps) => {
    const { t } = useTranslation();
    const { available, download } = useOfflineDownload();

    const entityType = libraryItemToOfflineEntityType(itemType);

    const onSelect = useCallback(() => {
        if (!entityType) return;
        const entities: OfflineDownloadEntity[] = items
            .filter((item) => item.id)
            .map((item) => ({
                entityType,
                id: item.id,
                name: item.name,
            }));
        void download(entities);
    }, [download, entityType, items]);

    if (!available || !entityType || items.length === 0) return null;

    return (
        <ContextMenu.Item leftIcon="cache" onSelect={onSelect}>
            {t('page.contextMenu.downloadForOffline', { defaultValue: 'Download for offline' })}
        </ContextMenu.Item>
    );
};
