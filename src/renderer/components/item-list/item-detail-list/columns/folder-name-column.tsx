import { ItemDetailListCellProps } from './types';

import { parentPathSegment } from '/@/shared/utils/album-folder-from-path';

export const FolderNameColumn = ({ song }: ItemDetailListCellProps) =>
    parentPathSegment(song.path) ?? <>&nbsp;</>;
