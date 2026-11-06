import { ReactNode, useCallback } from 'react';

import { RowPlayControlPopover } from '../../row-play-control-popover';
import styles from './row-play-control-cell.module.css';
import { ItemDetailListCellProps } from './types';

import { playSongFromItemListControl } from '/@/renderer/components/item-list/helpers/play-row-from-list';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    useIsCurrentSong,
    useIsCurrentSongPlaying,
} from '/@/renderer/features/player/hooks/use-is-current-song';
import { ItemRowPlayControls } from '/@/renderer/features/shared/components/item-row-play-controls';
import { Icon } from '/@/shared/components/icon/icon';
import { Play } from '/@/shared/types/types';

/** Row index / track number cell: now-playing icon and the hover play popover. */
export const ItemDetailRowPlayControlCell = ({
    label,
    song,
}: Pick<ItemDetailListCellProps, 'song'> & { label: ReactNode }) => {
    const player = usePlayer();
    const { isActive } = useIsCurrentSong(song);
    const isPlaying = useIsCurrentSongPlaying(song);

    const handlePlay = useCallback(
        (playType: Play) =>
            playSongFromItemListControl({
                item: song,
                meta: { playType, singleSongOnly: true },
                player,
            }),
        [player, song],
    );

    const indexContent = isActive ? (
        <div className={styles.iconWrapper}>
            <Icon fill="primary" icon={isPlaying ? 'mediaPlay' : 'mediaPause'} />
        </div>
    ) : (
        label
    );

    if (!song.id) {
        return <>{indexContent}</>;
    }

    return (
        <div className={styles.cellWrapper}>
            <RowPlayControlPopover
                content={<ItemRowPlayControls onPlay={handlePlay} />}
                offset={{ crossAxis: 32, mainAxis: 16 }}
                openDelay={300}
            >
                {indexContent}
            </RowPlayControlPopover>
        </div>
    );
};
