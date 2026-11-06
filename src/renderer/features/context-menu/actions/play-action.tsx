import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface PlayActionProps {
    ids: string[];
    itemType: LibraryItem;
    songs?: Song[];
}

export const PlayAction = ({ ids, itemType, songs }: PlayActionProps) => {
    const { t } = useTranslation();
    const player = usePlayer();
    const serverId = useCurrentServerId();

    const handlePlay = useCallback(
        (playType: Play) => {
            if (ids.length === 0 || !serverId) return;

            if (
                itemType === LibraryItem.SONG ||
                itemType === LibraryItem.PLAYLIST_SONG ||
                itemType === LibraryItem.QUEUE_SONG
            ) {
                // Menus opened from partial entities (pinned tiles build a
                // minimal { id, name, imageId } stub) must not enqueue the
                // stub — the queue row / now-playing / scrobble payload
                // would have no duration/artist/album. Resolve full songs
                // by id instead. PLAYLIST_SONG/QUEUE_SONG keep the data
                // path: their items carry playlist/queue context a re-fetch
                // would lose (and they always come from full rows).
                const list = songs || [];
                const hasStub =
                    itemType === LibraryItem.SONG &&
                    (list.length === 0 || list.some((s) => s.duration == null));
                if (hasStub) {
                    player.addToQueueByFetch(serverId, ids, LibraryItem.SONG, playType);
                } else {
                    player.addToQueueByData(list, playType);
                }
            } else {
                player.addToQueueByFetch(serverId, ids, itemType, playType);
            }
        },
        [ids, itemType, player, serverId, songs],
    );

    const playButtonBehavior = usePlayButtonBehavior();

    if (ids.length === 0) return null;

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    leftIcon="mediaPlay"
                    onSelect={() => handlePlay(playButtonBehavior)}
                    rightIcon="arrowRightS"
                >
                    {t('player.play')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item leftIcon="mediaPlay" onSelect={() => handlePlay(Play.NOW)}>
                    {t('player.play')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayNext" onSelect={() => handlePlay(Play.NEXT)}>
                    {t('player.addNext')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayLast" onSelect={() => handlePlay(Play.LAST)}>
                    {t('player.addLast')}
                </ContextMenu.Item>
                <ContextMenu.Divider />
                <ContextMenu.Item leftIcon="mediaShuffle" onSelect={() => handlePlay(Play.SHUFFLE)}>
                    {t('player.shuffle')}
                </ContextMenu.Item>
                <ContextMenu.Item
                    leftIcon="mediaPlayNext"
                    onSelect={() => handlePlay(Play.NEXT_SHUFFLE)}
                >
                    {t('player.addNextShuffled')}
                </ContextMenu.Item>
                <ContextMenu.Item
                    leftIcon="mediaPlayLast"
                    onSelect={() => handlePlay(Play.LAST_SHUFFLE)}
                >
                    {t('player.addLastShuffled')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
