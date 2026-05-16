import { ItemDetailListCellProps } from './types';

import { useShowFilesystemNameForAlbums } from '/@/renderer/store/settings.store';
import { albumFolderFromSongPath } from '/@/shared/utils/album-folder-from-path';

export const AlbumColumn = ({ song }: ItemDetailListCellProps) => {
    const useFsName = useShowFilesystemNameForAlbums();
    const fsName = useFsName ? albumFolderFromSongPath(song.path) : null;
    return fsName ?? song.album ?? <>&nbsp;</>;
};
