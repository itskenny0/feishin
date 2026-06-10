import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './pinned-shelf.module.css';

import {
    GridCarousel,
    useGridCarouselContainerQuery,
} from '/@/renderer/components/grid-carousel/grid-carousel-v2';
import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { getTitlePath } from '/@/renderer/components/item-list/helpers/get-title-path';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { Pin, PinItemType, usePins, usePinsActions } from '/@/renderer/store/pins.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';

interface PinnedCardProps {
    containerQuery?: ReturnType<typeof useGridCarouselContainerQuery>;
    pin: Pin;
}

const isRoundType = (itemType: PinItemType) =>
    itemType === LibraryItem.ALBUM_ARTIST || itemType === LibraryItem.ARTIST;

const PinnedCard = memo(({ pin }: PinnedCardProps) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const player = usePlayer();
    const playButtonBehavior = usePlayButtonBehavior();
    const serverId = useCurrentServerId();
    const { removePin } = usePinsActions();

    const navigationPath = useMemo(
        () => getTitlePath(pin.itemType, pin.id),
        [pin.id, pin.itemType],
    );

    const handleNavigate = useCallback(() => {
        // Songs have no detail route - play them instead.
        if (pin.itemType === LibraryItem.SONG) {
            if (!serverId) return;
            player.addToQueueByFetch(serverId, [pin.id], LibraryItem.SONG, playButtonBehavior);
            return;
        }

        if (navigationPath) {
            navigate(navigationPath, { state: { item: pin } });
        }
    }, [navigate, navigationPath, pin, playButtonBehavior, player, serverId]);

    const handleUnpin = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            removePin(pin.serverId, pin.itemType, pin.id);
        },
        [pin.id, pin.itemType, pin.serverId, removePin],
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleNavigate();
            }
        },
        [handleNavigate],
    );

    return (
        <div className={styles.card}>
            <div className={styles.imageWrapper}>
                <div
                    aria-label={pin.name}
                    className={styles.imageButton}
                    onClick={handleNavigate}
                    onKeyDown={handleKeyDown}
                    role="button"
                    tabIndex={0}
                >
                    <ItemImage
                        className={isRoundType(pin.itemType) ? styles.roundImage : styles.image}
                        id={pin.imageId}
                        itemType={pin.itemType}
                        src={pin.imageUrl}
                        type="itemCard"
                    />
                </div>
                <div className={styles.unpinButton}>
                    <ActionIcon
                        aria-label={t('action.unpinFromHome', { postProcess: 'sentenceCase' })}
                        icon="unpin"
                        iconProps={{ size: 'sm' }}
                        onClick={handleUnpin}
                        size="sm"
                        tooltip={{
                            label: t('action.unpinFromHome', { postProcess: 'sentenceCase' }),
                        }}
                        variant="default"
                    />
                </div>
            </div>
            <Text isNoSelect lineClamp={2} size="sm" weight={500}>
                {pin.name}
            </Text>
        </div>
    );
});

PinnedCard.displayName = 'PinnedCard';

interface PinnedShelfProps {
    containerQuery?: ReturnType<typeof useGridCarouselContainerQuery>;
}

export const PinnedShelf = memo(({ containerQuery }: PinnedShelfProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const pins = usePins(serverId);

    const cards = useMemo(
        () =>
            pins.map((pin) => ({
                content: <PinnedCard containerQuery={containerQuery} pin={pin} />,
                id: `${pin.itemType}-${pin.id}`,
            })),
        [containerQuery, pins],
    );

    if (pins.length === 0) {
        return null;
    }

    return (
        <GridCarousel
            cards={cards}
            containerQuery={containerQuery}
            onNextPage={() => {}}
            onPrevPage={() => {}}
            rowCount={1}
            title={t('page.home.pinned', { postProcess: 'sentenceCase' })}
        />
    );
});

PinnedShelf.displayName = 'PinnedShelf';
