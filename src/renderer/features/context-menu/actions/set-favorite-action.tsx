import { useTranslation } from 'react-i18next';

import { useSetFavorite } from '/@/renderer/features/shared/hooks/use-set-favorite';
import { useCurrentServerId, useShowFavorites } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { LibraryItem } from '/@/shared/types/domain-types';

interface SetFavoriteActionProps {
    ids: string[];
    itemType: LibraryItem;
}

export const SetFavoriteAction = ({ ids, itemType }: SetFavoriteActionProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const showFavorites = useShowFavorites();

    const setFavorite = useSetFavorite();

    const handleSetFavorite = (isFavorite: boolean) => {
        if (ids.length === 0 || !serverId) return;
        setFavorite(serverId, ids, itemType, isFavorite);
    };

    if (!showFavorites) {
        return null;
    }

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    leftIcon="favorite"
                    onSelect={(e) => e.preventDefault()}
                    rightIcon="arrowRightS"
                >
                    {t('common.favorite')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item leftIcon="favorite" onSelect={() => handleSetFavorite(true)}>
                    {t('action.addToFavorites')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="unfavorite" onSelect={() => handleSetFavorite(false)}>
                    {t('action.removeFromFavorites')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
