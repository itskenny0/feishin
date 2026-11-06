import { useTranslation } from 'react-i18next';

import { useSetRating } from '/@/renderer/features/shared/hooks/use-set-rating';
import { useCurrentServer, useCurrentServerId, useShowRatings } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Rating } from '/@/shared/components/rating/rating';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ServerType } from '/@/shared/types/types';

interface SetRatingActionProps {
    ids: string[];
    itemType: LibraryItem;
}

export const SetRatingAction = ({ ids, itemType }: SetRatingActionProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const serverId = useCurrentServerId();
    const showRatings = useShowRatings();

    const setRating = useSetRating();

    const isRatingSupported =
        server?.type === ServerType.NAVIDROME || server?.type === ServerType.SUBSONIC;

    const onRating = (rating: number) => {
        setRating(serverId, ids, itemType, rating);
    };

    if (!showRatings || !isRatingSupported) {
        return null;
    }

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    leftIcon="star"
                    onSelect={(e) => e.preventDefault()}
                    rightIcon="arrowRightS"
                >
                    {t('action.setRating')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                {[0, 1, 2, 3, 4, 5].map((rating) => (
                    <ContextMenu.Item key={rating} onSelect={() => onRating(rating)}>
                        <Rating
                            preventDefault={false}
                            readOnly
                            stopPropagation={false}
                            value={rating}
                        />
                    </ContextMenu.Item>
                ))}
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
