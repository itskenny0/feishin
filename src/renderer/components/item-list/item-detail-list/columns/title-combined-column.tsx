import clsx from 'clsx';

import styles from './title-column.module.css';

import { useIsSongOfflineAvailable } from '/@/renderer/cache';
import { ItemDetailListCellProps } from '/@/renderer/components/item-list/item-detail-list/columns/types';
import { useIsCurrentSong } from '/@/renderer/features/player/hooks/use-is-current-song';
import { ExplicitIndicator } from '/@/shared/components/explicit-indicator/explicit-indicator';
import { OfflineIndicator } from '/@/shared/components/offline-indicator/offline-indicator';

export const TitleCombinedColumn = ({ song }: ItemDetailListCellProps) => {
    const { isActive } = useIsCurrentSong(song);
    const offlineAvailable = useIsSongOfflineAvailable(song._serverId, song.id);

    return (
        <span className={clsx({ [styles.active]: isActive })}>
            <OfflineIndicator visible={offlineAvailable} />
            <ExplicitIndicator explicitStatus={song.explicitStatus} />
            {[song.name, song.artistName].filter(Boolean).join(' — ') ?? <>&nbsp;</>}
        </span>
    );
};
