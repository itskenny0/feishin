import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './pinned-shelf.module.css';
import qpStyles from './spotify-home/quick-picks.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { getTitlePath } from '/@/renderer/components/item-list/helpers/get-title-path';
import { ShelfTitle } from '/@/renderer/features/home/components/spotify-home/shelf-title';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { Pin, PinItemType, usePins, usePinsActions } from '/@/renderer/store/pins.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';

const isRoundType = (itemType: PinItemType) =>
    itemType === LibraryItem.ALBUM_ARTIST || itemType === LibraryItem.ARTIST;

/**
 * One pinned entry, rendered EXACTLY like the quick-picks tiles right below
 * it (cover flush-left, name filling the width) so the pinned zone reads as
 * part of the home top zone instead of a separate carousel of big cards.
 * The unpin affordance replaces quick-picks' hover play button and is
 * always visible — pins are explicitly managed chrome.
 */
const PinnedTile = memo(({ pin }: { pin: Pin }) => {
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

    const handleOpen = useCallback(() => {
        // Songs have no detail route — play them instead.
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
                handleOpen();
            }
        },
        [handleOpen],
    );

    return (
        <div
            aria-label={pin.name}
            className={qpStyles.tile}
            onClick={handleOpen}
            onKeyDown={handleKeyDown}
            role="button"
            tabIndex={0}
        >
            <div
                className={`${qpStyles.tileImage} ${isRoundType(pin.itemType) ? styles.roundImage : ''}`}
            >
                <ItemImage
                    id={pin.imageId}
                    itemType={pin.itemType}
                    src={pin.imageUrl ?? undefined}
                    type="itemCard"
                />
            </div>
            <Text className={qpStyles.tileTitle} isNoSelect overflow="hidden">
                {pin.name}
            </Text>
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
                    variant="subtle"
                />
            </div>
        </div>
    );
});

PinnedTile.displayName = 'PinnedTile';

/**
 * Pinned items zone — sits directly under the hero (greeting + lucky
 * button) and above quick picks, using the same wide-tile grid so the two
 * zones read as one. Renders nothing when the current server has no pins.
 */
export const PinnedShelf = memo(() => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const pins = usePins(serverId);

    if (pins.length === 0) {
        return null;
    }

    return (
        <div>
            <ShelfTitle title={t('page.home.pinned', { postProcess: 'sentenceCase' })} />
            <div className={qpStyles.grid}>
                {pins.map((pin) => (
                    <PinnedTile key={`${pin.itemType}-${pin.id}`} pin={pin} />
                ))}
            </div>
        </div>
    );
});

PinnedShelf.displayName = 'PinnedShelf';
