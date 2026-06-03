import { useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';

import { useItemListColumnReorder } from '/@/renderer/components/item-list/helpers/use-item-list-column-reorder';
import { useItemListColumnResize } from '/@/renderer/components/item-list/helpers/use-item-list-column-resize';
import { ItemTableList } from '/@/renderer/components/item-list/item-table-list/item-table-list';
import { ItemTableListColumn } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { ErrorFallback } from '/@/renderer/features/action-required/components/error-fallback';
import { RouteSkeleton } from '/@/renderer/features/shared/components/route-skeleton';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useListSettings } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

export type SimilarSongsListProps = {
    count?: number;
    fullScreen?: boolean;
    song: Song;
};

const StateContainer = ({ children }: { children: React.ReactNode }) => (
    <Center style={{ height: '100%', padding: '2rem', width: '100%' }}>
        <Stack align="center" gap="sm" style={{ maxWidth: '24rem', textAlign: 'center' }}>
            {children}
        </Stack>
    </Center>
);

export const SimilarSongsList = ({ count, song }: SimilarSongsListProps) => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();

    const songQuery = useQuery(
        songsQueries.similar({
            options: {
                gcTime: 1000 * 60 * 2,
            },
            query: {
                count,
                songId: song.id,
            },
            serverId: song?._serverId,
        }),
    );

    const { table } = useListSettings(ItemListKey.FULL_SCREEN);

    const { handleColumnReordered } = useItemListColumnReorder({
        itemListKey: ItemListKey.FULL_SCREEN,
    });

    const { handleColumnResized } = useItemListColumnResize({
        itemListKey: ItemListKey.FULL_SCREEN,
    });

    const tableData = songQuery.data ?? [];

    // Only show the full skeleton on the very first load. Background
    // revalidation (refetch on song change) keeps the previous list
    // visible to avoid a jarring full-surface flash on every track.
    if (songQuery.isLoading && tableData.length === 0) {
        return <RouteSkeleton />;
    }

    if (songQuery.isError && tableData.length === 0) {
        return (
            <StateContainer>
                <Icon fill="error" icon="error" size="xl" />
                <Text weight={600}>{t('error.genericError', { postProcess: 'sentenceCase' })}</Text>
                <Button
                    disabled={songQuery.isFetching}
                    onClick={() => songQuery.refetch()}
                    variant="filled"
                >
                    {t('common.retry', { postProcess: 'sentenceCase' })}
                </Button>
            </StateContainer>
        );
    }

    if (tableData.length === 0) {
        return (
            <StateContainer>
                <Icon icon="itemSong" size="xl" />
                <Text isMuted>
                    {t('common.noResultsFromQuery', { postProcess: 'sentenceCase' })}
                </Text>
            </StateContainer>
        );
    }

    return (
        <ErrorBoundary FallbackComponent={ErrorFallback}>
            <ItemTableList
                autoFitColumns={table?.autoFitColumns}
                CellComponent={ItemTableListColumn}
                columns={table?.columns || []}
                data={tableData}
                enableAlternateRowColors={table?.enableAlternateRowColors}
                enableExpansion={false}
                enableHeader={isMobile ? false : table?.enableHeader}
                enableHorizontalBorders={isMobile ? false : table?.enableHorizontalBorders}
                enableRowHoverHighlight={table?.enableRowHoverHighlight}
                enableScrollShadow={false}
                enableSelection
                enableSelectionDialog={false}
                enableVerticalBorders={isMobile ? false : table?.enableVerticalBorders}
                itemType={LibraryItem.SONG}
                onColumnReordered={handleColumnReordered}
                onColumnResized={handleColumnResized}
                size={isMobile ? 'compact' : table?.size}
            />
        </ErrorBoundary>
    );
};
