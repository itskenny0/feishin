import { type ReactNode } from 'react';

import type { ItemDetailListCellProps } from './types';

import { ActionsColumn } from './actions-column';
import { AlbumColumn } from './album-column';
import { AlbumArtistColumn, ArtistColumn } from './artist-column';
import { BitDepthColumn } from './bit-depth-column';
import { BitRateColumn } from './bit-rate-column';
import { BpmColumn } from './bpm-column';
import { ChannelsColumn } from './channels-column';
import { CodecColumn } from './codec-column';
import { CommentColumn } from './comment-column';
import { ComposerColumn } from './composer-column';
import { DateAddedColumn } from './date-added-column';
import { DateColumn } from './date-column';
import { DefaultColumn } from './default-column';
import { DiscNumberColumn } from './disc-number-column';
import { DurationColumn } from './duration-column';
import { FavoriteColumn } from './favorite-column';
import { FolderNameColumn } from './folder-name-column';
import { GenreBadgeColumn } from './genre-badge-column';
import { GenreColumn } from './genre-column';
import { ImageColumn } from './image-column';
import { LastPlayedColumn } from './last-played-column';
import { PathColumn } from './path-column';
import { PlayCountColumn } from './play-count-column';
import { RatingColumn } from './rating-column';
import { ReleaseDateColumn } from './release-date-column';
import { ReleaseYearColumn } from './release-year-column';
import { RowIndexColumn } from './row-index-column';
import { SampleRateColumn } from './sample-rate-column';
import { SizeColumn } from './size-column';
import { TitleArtistColumn, TitleColumn, TitleCombinedColumn } from './title-column';
import { TrackNumberColumn } from './track-number-column';
import { YearColumn } from './year-column';

import { TableColumn } from '/@/shared/types/types';

type CellComponent = (props: ItemDetailListCellProps) => ReactNode;

const COLUMN_MAP: Partial<Record<TableColumn, CellComponent>> = {
    [TableColumn.ACTIONS]: ActionsColumn,
    [TableColumn.ALBUM]: AlbumColumn,
    [TableColumn.ALBUM_ARTIST]: AlbumArtistColumn,
    [TableColumn.ARTIST]: ArtistColumn,
    [TableColumn.BIT_DEPTH]: BitDepthColumn,
    [TableColumn.BIT_RATE]: BitRateColumn,
    [TableColumn.BPM]: BpmColumn,
    [TableColumn.CHANNELS]: ChannelsColumn,
    [TableColumn.CODEC]: CodecColumn,
    [TableColumn.COMMENT]: CommentColumn,
    [TableColumn.COMPOSER]: ComposerColumn,
    [TableColumn.DATE]: DateColumn,
    [TableColumn.DATE_ADDED]: DateAddedColumn,
    [TableColumn.DISC_NUMBER]: DiscNumberColumn,
    [TableColumn.DURATION]: DurationColumn,
    [TableColumn.FOLDER_NAME]: FolderNameColumn,
    [TableColumn.GENRE]: GenreColumn,
    [TableColumn.GENRE_BADGE]: GenreBadgeColumn,
    [TableColumn.IMAGE]: ImageColumn,
    [TableColumn.LAST_PLAYED]: LastPlayedColumn,
    [TableColumn.PATH]: PathColumn,
    [TableColumn.PLAY_COUNT]: PlayCountColumn,
    [TableColumn.RELEASE_DATE]: ReleaseDateColumn,
    [TableColumn.RELEASE_YEAR]: ReleaseYearColumn,
    [TableColumn.ROW_INDEX]: RowIndexColumn,
    [TableColumn.SAMPLE_RATE]: SampleRateColumn,
    [TableColumn.SIZE]: SizeColumn,
    [TableColumn.TITLE]: TitleColumn,
    [TableColumn.TITLE_ARTIST]: TitleArtistColumn,
    [TableColumn.TITLE_COMBINED]: TitleCombinedColumn,
    [TableColumn.TRACK_NUMBER]: TrackNumberColumn,
    [TableColumn.USER_FAVORITE]: FavoriteColumn,
    [TableColumn.USER_RATING]: RatingColumn,
    [TableColumn.YEAR]: YearColumn,
};

export type DetailListCellComponentProps = ItemDetailListCellProps & { columnId: string };

export const getDetailListCellComponent = (
    columnId: string | TableColumn,
): ((props: DetailListCellComponentProps) => ReactNode) =>
    COLUMN_MAP[columnId as TableColumn] ?? DefaultColumn;
