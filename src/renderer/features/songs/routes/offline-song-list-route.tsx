import { Stack } from '@mantine/core';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useOfflineSongs } from '/@/renderer/cache';
import { playSongFromItemListControl } from '/@/renderer/components/item-list/helpers/play-row-from-list';
import { useItemListColumnReorder } from '/@/renderer/components/item-list/helpers/use-item-list-column-reorder';
import { useItemListColumnResize } from '/@/renderer/components/item-list/helpers/use-item-list-column-resize';
import { ItemTableList } from '/@/renderer/components/item-list/item-table-list/item-table-list';
import { ItemTableListColumn } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { ItemControls } from '/@/renderer/components/item-list/types';
import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { ListContext } from '/@/renderer/context/list-context';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { usePlayerSong } from '/@/renderer/store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { Badge } from '/@/shared/components/badge/badge';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { SpinnerIcon } from '/@/shared/components/spinner/spinner';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

/**
 * "Available offline" library view. Self-contained route (no server query):
 * lists every track the user has downloaded for offline playback, sourced from
 * the offline blob store joined against the cached song metadata. Reuses the
 * shared `ItemTableList` so it looks and behaves like every other song list.
 *
 * The My Library entry that links here is hidden when nothing is downloaded
 * (see `useOfflineSongCount`); this route also degrades gracefully to an empty
 * state if reached directly with nothing available.
 */
const OfflineSongListRoute = () => {
    const { t } = useTranslation();
    const pageKey = LibraryItem.SONG;

    const offlineQuery = useOfflineSongs();
    const songs = useMemo(() => offlineQuery.data ?? [], [offlineQuery.data]);
    const itemCount = offlineQuery.isLoading ? undefined : songs.length;

    const tableConfig = useSettingsStore((state) => state.lists[ItemListKey.SONG]?.table);
    const currentSong = usePlayerSong();
    const player = usePlayer();

    const columns = useMemo(() => {
        return tableConfig?.columns || [];
    }, [tableConfig?.columns]);

    const { handleColumnReordered } = useItemListColumnReorder({
        itemListKey: ItemListKey.SONG,
    });

    const { handleColumnResized } = useItemListColumnResize({
        itemListKey: ItemListKey.SONG,
    });

    const overrideControls: Partial<ItemControls> = useMemo(() => {
        return {
            onDoubleClick: ({ index, internalState, item, meta }) => {
                if (!item) {
                    return;
                }

                playSongFromItemListControl({
                    index,
                    internalState,
                    item: item as Song,
                    meta,
                    player,
                });
            },
        };
    }, [player]);

    const providerValue = useMemo(() => {
        return {
            pageKey,
        };
    }, [pageKey]);

    const currentSongId = currentSong?.id;

    const header = (
        <PageHeader>
            <LibraryHeaderBar ignoreMaxWidth>
                <LibraryHeaderBar.PlayButton itemType={LibraryItem.SONG} songs={songs} />
                <LibraryHeaderBar.Title order={2}>
                    {t('page.sidebar.offline', { defaultValue: 'Available offline' })}
                </LibraryHeaderBar.Title>
                <Badge>
                    {itemCount === null || itemCount === undefined ? <SpinnerIcon /> : itemCount}
                </Badge>
            </LibraryHeaderBar>
        </PageHeader>
    );

    if (!offlineQuery.isLoading && songs.length === 0) {
        return (
            <AnimatedPage>
                <ListContext.Provider value={providerValue}>
                    {header}
                    <EmptyState
                        description={t('page.offlineList.emptyDescription', {
                            defaultValue:
                                'Download albums, playlists, or tracks to make them available offline.',
                        })}
                        title={t('page.offlineList.empty', {
                            defaultValue: 'Nothing available offline',
                        })}
                    />
                </ListContext.Provider>
            </AnimatedPage>
        );
    }

    // First-load skeleton: the offline join (one chunked bulkGet of thousands
    // of Song payloads) used to leave the body blank for ~10s. Paint placeholder
    // rows immediately so the page feels instant while the rows stream in.
    if (offlineQuery.isLoading) {
        return (
            <AnimatedPage>
                <ListContext.Provider value={providerValue}>
                    {header}
                    <Stack gap="xs" p="md">
                        {Array.from({ length: 14 }).map((_, i) => (
                            <Skeleton height={40} key={i} radius="sm" />
                        ))}
                    </Stack>
                </ListContext.Provider>
            </AnimatedPage>
        );
    }

    if (!tableConfig || columns.length === 0) {
        return (
            <AnimatedPage>
                <ListContext.Provider value={providerValue}>{header}</ListContext.Provider>
            </AnimatedPage>
        );
    }

    return (
        <AnimatedPage>
            <ListContext.Provider value={providerValue}>
                {header}
                <ItemTableList
                    activeRowId={currentSongId}
                    autoFitColumns={tableConfig.autoFitColumns}
                    CellComponent={ItemTableListColumn}
                    columns={columns}
                    data={songs}
                    enableAlternateRowColors={tableConfig.enableAlternateRowColors}
                    enableDrag
                    enableExpansion={false}
                    enableHeader={tableConfig.enableHeader}
                    enableHorizontalBorders={tableConfig.enableHorizontalBorders}
                    enableRowHoverHighlight={tableConfig.enableRowHoverHighlight}
                    enableSelection
                    enableSelectionDialog={false}
                    enableVerticalBorders={tableConfig.enableVerticalBorders}
                    itemType={LibraryItem.SONG}
                    onColumnReordered={handleColumnReordered}
                    onColumnResized={handleColumnResized}
                    overrideControls={overrideControls}
                    size={tableConfig.size}
                />
            </ListContext.Provider>
        </AnimatedPage>
    );
};

const OfflineSongListRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <OfflineSongListRoute />
        </PageErrorBoundary>
    );
};

export default OfflineSongListRouteWithBoundary;
