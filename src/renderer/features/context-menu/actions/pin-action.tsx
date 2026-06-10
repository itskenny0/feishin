import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useCurrentServerId } from '/@/renderer/store';
import { PinItemType, useIsPinned, usePinsActions } from '/@/renderer/store/pins.store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';

interface PinActionProps {
    items: PinnableItem[];
    itemType: PinItemType;
}

interface PinnableItem {
    id: string;
    imageId?: null | string;
    imageUrl?: null | string;
    name: string;
}

export const PinAction = ({ items, itemType }: PinActionProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const { addPin, removePin } = usePinsActions();

    // When multiple items are selected, the toggle label reflects the first item.
    const firstId = items[0]?.id;
    const firstIsPinned = useIsPinned(serverId, itemType, firstId);

    const allPinnable = useMemo(
        () => items.filter((item) => Boolean(item?.id && item?.name)),
        [items],
    );

    const handlePin = useCallback(() => {
        if (!serverId || allPinnable.length === 0) return;

        for (const item of allPinnable) {
            addPin({
                id: item.id,
                imageId: item.imageId ?? null,
                imageUrl: item.imageUrl ?? null,
                itemType,
                name: item.name,
                serverId,
            });
        }
    }, [addPin, allPinnable, itemType, serverId]);

    const handleUnpin = useCallback(() => {
        if (!serverId || allPinnable.length === 0) return;

        for (const item of allPinnable) {
            removePin(serverId, itemType, item.id);
        }
    }, [allPinnable, itemType, removePin, serverId]);

    if (allPinnable.length === 0) return null;

    if (firstIsPinned) {
        return (
            <ContextMenu.Item leftIcon="unpin" onSelect={handleUnpin}>
                {t('action.unpinFromHome', { postProcess: 'sentenceCase' })}
            </ContextMenu.Item>
        );
    }

    return (
        <ContextMenu.Item leftIcon="pin" onSelect={handlePin}>
            {t('action.pinToHome', { postProcess: 'sentenceCase' })}
        </ContextMenu.Item>
    );
};
