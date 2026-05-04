import { ItemDetailListCellProps } from './types';

export const FolderNameColumn = ({ song }: ItemDetailListCellProps) => {
    const path = song.path;
    if (!path) return <>&nbsp;</>;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length < 2) return <>&nbsp;</>;
    return segments[segments.length - 2] || <>&nbsp;</>;
};
