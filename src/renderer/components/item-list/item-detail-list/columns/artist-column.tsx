import styles from './artists-column.module.css';
import { ItemDetailListCellProps } from './types';

import {
    JOINED_ARTISTS_MUTED_PROPS,
    JoinedArtists,
} from '/@/renderer/features/albums/components/joined-artists';
import { RelatedArtist } from '/@/shared/types/domain-types';

const ArtistsCell = ({
    artistName,
    artists,
    isRowHovered,
}: {
    artistName: null | string | undefined;
    artists: RelatedArtist[] | undefined;
    isRowHovered?: boolean;
}) => {
    if (!artistName?.trim() && !artists?.length) return <>&nbsp;</>;

    return (
        <JoinedArtists
            artistName={artistName ?? ''}
            artists={artists ?? []}
            linkProps={JOINED_ARTISTS_MUTED_PROPS.linkProps}
            readOnly={!isRowHovered}
            rootTextProps={{
                ...JOINED_ARTISTS_MUTED_PROPS.rootTextProps,
                className: styles.artists,
            }}
        />
    );
};

export const ArtistColumn = ({ isRowHovered, song }: ItemDetailListCellProps) => (
    <ArtistsCell artistName={song.artistName} artists={song.artists} isRowHovered={isRowHovered} />
);

export const AlbumArtistColumn = ({ isRowHovered, song }: ItemDetailListCellProps) => (
    <ArtistsCell
        artistName={song.albumArtistName}
        artists={song.albumArtists}
        isRowHovered={isRowHovered}
    />
);
