import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './pinned-shelf.module.css';
import qpStyles from './spotify-home/quick-picks.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { getTitlePath } from '/@/renderer/components/item-list/helpers/get-title-path';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { ShelfTitle } from '/@/renderer/features/home/components/spotify-home/shelf-title';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useLongPress } from '/@/renderer/hooks/use-long-press';
import { useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { Pin, PinItemType, usePins, usePinsActions } from '/@/renderer/store/pins.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem } from '/@/shared/types/domain-types';

const isRoundType = (itemType: PinItemType) =>
    itemType === LibraryItem.ALBUM_ARTIST || itemType === LibraryItem.ARTIST;

/**
 * Reconstruct the minimal entity the per-type context menu needs from a
 * stored Pin. The context-menu actions read `id` / `_serverId` / `name`
 * (and optionally the image fields for the preview); the menu picked by
 * `cmd.type` is the same one the rest of the app uses for that item type,
 * so the entries match (play, add to playlist, favorite, pin/unpin, go to,
 * etc.) without hand-building any menu here. `_itemType` mirrors the type
 * so downstream `_itemType`-based branching resolves correctly.
 */
const pinToContextItem = (pin: Pin) => ({
    _itemType: pin.itemType,
    _serverId: pin.serverId,
    id: pin.id,
    imageId: pin.imageId ?? null,
    imageUrl: pin.imageUrl ?? null,
    name: pin.name,
});

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

    // Open the pin's per-type context menu (same menu the rest of the app
    // uses for that item type). Shared by desktop right-click and touch
    // long-press. Bails if the gesture started on the unpin button so a
    // press there only unpins.
    const openContextMenu = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            const target = event.target as HTMLElement;
            if (target.closest('button')) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            ContextMenuController.call({
                cmd: {
                    items: [pinToContextItem(pin)] as never,
                    type: pin.itemType as never,
                },
                event,
            });
        },
        [pin],
    );

    // Tap keeps the existing onClick path (a plain div's click fires reliably
    // on touch — unlike the React Router <Link> tap the carousels needed
    // patched). Only long-press is added here; onClickCapture swallows the
    // synthesised click that follows a long-press so the menu doesn't also
    // navigate/play.
    const longPressHandlers = useLongPress({
        onLongPress: (event) => openContextMenu(event as React.MouseEvent<HTMLElement>),
    });

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
            onClickCapture={longPressHandlers.onClickCapture}
            onContextMenu={openContextMenu}
            onContextMenuCapture={longPressHandlers.onContextMenuCapture}
            onKeyDown={handleKeyDown}
            onPointerCancel={longPressHandlers.onPointerCancel}
            onPointerDown={longPressHandlers.onPointerDown}
            onPointerMove={longPressHandlers.onPointerMove}
            onPointerUp={longPressHandlers.onPointerUp}
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
            <div
                className={styles.unpinButton}
                // Keep the long-press gesture (armed on the tile's pointerdown)
                // from ever starting when the press lands on the unpin button —
                // a press here only unpins, never pops the context menu.
                onPointerDown={(e) => e.stopPropagation()}
            >
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
