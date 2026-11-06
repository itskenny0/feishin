import clsx from 'clsx';
import { ReactNode } from 'react';

import styles from './title-column.module.css';

import { useIsSongOfflineAvailable } from '/@/renderer/cache';
import { ItemDetailListCellProps } from '/@/renderer/components/item-list/item-detail-list/columns/types';
import { useIsCurrentSong } from '/@/renderer/features/player/hooks/use-is-current-song';
import { ExplicitIndicator } from '/@/shared/components/explicit-indicator/explicit-indicator';
import { OfflineIndicator } from '/@/shared/components/offline-indicator/offline-indicator';
import { Song } from '/@/shared/types/domain-types';

const SongOfflineIndicator = ({ song }: { song: Song }) => (
    <OfflineIndicator visible={useIsSongOfflineAvailable(song._serverId, song.id)} />
);

const SongTitle = ({
    song,
    text,
    withOffline,
}: {
    song: Song;
    text: ReactNode;
    withOffline?: boolean;
}) => {
    const { isActive } = useIsCurrentSong(song);

    return (
        <span className={clsx({ [styles.active]: isActive })}>
            {withOffline && <SongOfflineIndicator song={song} />}
            <ExplicitIndicator explicitStatus={song.explicitStatus} />
            {text}
        </span>
    );
};

const titleWithArtist = (song: Song) =>
    [song.name, song.artistName].filter(Boolean).join(' \u2014 ');

export const TitleColumn = ({ song }: ItemDetailListCellProps) => (
    <SongTitle song={song} text={song.name ?? <>&nbsp;</>} withOffline />
);

export const TitleCombinedColumn = ({ song }: ItemDetailListCellProps) => (
    <SongTitle song={song} text={titleWithArtist(song)} withOffline />
);

export const TitleArtistColumn = ({ song }: ItemDetailListCellProps) => (
    <SongTitle song={song} text={titleWithArtist(song)} />
);
