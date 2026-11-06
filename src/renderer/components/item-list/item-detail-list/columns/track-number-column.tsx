import { ItemDetailRowPlayControlCell } from './row-play-control-cell';
import { ItemDetailListCellProps } from './types';

import { isRowPlayControlColumn } from '/@/renderer/components/item-list/helpers/get-row-play-control-column';
import { TableColumn } from '/@/shared/types/types';

const formatTrackNumber = (song: ItemDetailListCellProps['song']) => {
    const disc = song.discNumber ?? 1;
    // Jellyfin libraries without track-number tags have no trackNumber.
    if (song.trackNumber == null) return `${disc}-`;
    return `${disc}-${song.trackNumber.toString().padStart(2, '0')}`;
};

export const TrackNumberColumn = ({ columns, song }: ItemDetailListCellProps) => {
    const label = formatTrackNumber(song);

    if (!columns || !isRowPlayControlColumn(TableColumn.TRACK_NUMBER, columns)) {
        return label;
    }

    return <ItemDetailRowPlayControlCell label={label} song={song} />;
};
