import { useTranslation } from 'react-i18next';

import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { usePlayButtonBehavior } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface RadioSubmenuProps {
    disabled?: boolean;
    label: string;
    // Resolves the songs to enqueue for the chosen play type; an empty result
    // enqueues nothing.
    loadSongs: (playType: Play) => Promise<Song[] | undefined>;
}

/** Play / add next / add last submenu shared by the album, artist and track radio actions. */
export const RadioSubmenu = ({ disabled, label, loadSongs }: RadioSubmenuProps) => {
    const { t } = useTranslation();
    const player = usePlayer();
    const playButtonBehavior = usePlayButtonBehavior();

    const play = async (playType: Play) => {
        try {
            const songs = await loadSongs(playType);
            if (songs?.length) player.addToQueueByData(songs, playType);
        } catch (error) {
            logger.error(`[radio] failed to load ${label}`, { error });
        }
    };

    return (
        <ContextMenu.Submenu>
            <ContextMenu.SubmenuTarget>
                <ContextMenu.Item
                    disabled={disabled}
                    leftIcon="radio"
                    onSelect={() => play(playButtonBehavior)}
                    rightIcon="arrowRightS"
                >
                    {label}
                </ContextMenu.Item>
            </ContextMenu.SubmenuTarget>
            <ContextMenu.SubmenuContent>
                <ContextMenu.Item leftIcon="mediaPlay" onSelect={() => play(Play.NOW)}>
                    {t('player.play')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayNext" onSelect={() => play(Play.NEXT)}>
                    {t('player.addNext')}
                </ContextMenu.Item>
                <ContextMenu.Item leftIcon="mediaPlayLast" onSelect={() => play(Play.LAST)}>
                    {t('player.addLast')}
                </ContextMenu.Item>
            </ContextMenu.SubmenuContent>
        </ContextMenu.Submenu>
    );
};
