import { ItemDetailListCellProps } from './types';

export const TrackNumberColumn = ({ song }: ItemDetailListCellProps) => {
    const disc = song.discNumber ?? 1;
    if (song.trackNumber == null) {
        // Jellyfin libraries without track-number tags return undefined here,
        // which previously crashed the column with a .toString() on undefined.
        return `${disc}-`;
    }
    const track = song.trackNumber.toString().padStart(2, '0');
    return `${disc}-${track}`;
};
