import { ItemDetailListCellProps } from './types';

import { useShowFilesystemNameForAlbums } from '/@/renderer/store/settings.store';

const albumFolderNameFromSongPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length < 2) return null;
    return segments[segments.length - 2] ?? null;
};

export const AlbumColumn = ({ song }: ItemDetailListCellProps) => {
    const useFsName = useShowFilesystemNameForAlbums();
    const fsName = useFsName ? albumFolderNameFromSongPath(song.path) : null;
    return fsName ?? song.album ?? <>&nbsp;</>;
};
