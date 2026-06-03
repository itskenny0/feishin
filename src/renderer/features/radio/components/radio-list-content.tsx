import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useListContext } from '/@/renderer/context/list-context';
import { radioQueries } from '/@/renderer/features/radio/api/radio-api';
import { openCreateRadioStationModal } from '/@/renderer/features/radio/components/create-radio-station-form';
import { RadioListItems } from '/@/renderer/features/radio/components/radio-list-items';
import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import { RouteSkeleton } from '/@/renderer/features/shared/components/route-skeleton';
import { useSearchTermFilter } from '/@/renderer/features/shared/hooks/use-search-term-filter';
import { useSortByFilter } from '/@/renderer/features/shared/hooks/use-sort-by-filter';
import { useSortOrderFilter } from '/@/renderer/features/shared/hooks/use-sort-order-filter';
import { searchLibraryItems } from '/@/renderer/features/shared/utils';
import { useCurrentServer, usePermissions } from '/@/renderer/store';
import { sortRadioList } from '/@/shared/api/utils';
import { Button } from '/@/shared/components/button/button';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';
import { LibraryItem, RadioListSort, SortOrder } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

export const RadioListContent = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const permissions = usePermissions();
    const { setItemCount } = useListContext();
    const { searchTerm } = useSearchTermFilter();
    const { sortBy } = useSortByFilter<RadioListSort>(RadioListSort.NAME, ItemListKey.RADIO);
    const { sortOrder } = useSortOrderFilter(SortOrder.ASC, ItemListKey.RADIO);

    const radioListQuery = useQuery({
        ...radioQueries.list({
            query: undefined,
            serverId: server?.id || '',
        }),
    });

    const filteredAndSortedRadioStations = useMemo(() => {
        let stations = radioListQuery.data || [];

        if (searchTerm) {
            stations = searchLibraryItems(stations, searchTerm, LibraryItem.RADIO_STATION);
        }

        if (sortBy && sortOrder) {
            stations = sortRadioList(stations, sortBy, sortOrder);
        }

        return stations;
    }, [radioListQuery.data, searchTerm, sortBy, sortOrder]);

    useEffect(() => {
        setItemCount?.(filteredAndSortedRadioStations.length || 0);
    }, [filteredAndSortedRadioStations.length, setItemCount]);

    if (radioListQuery.isLoading) {
        return <RouteSkeleton />;
    }

    if (radioListQuery.isError) {
        return (
            <EmptyState
                action={
                    <Button
                        loading={radioListQuery.isFetching}
                        onClick={() => radioListQuery.refetch()}
                        variant="filled"
                    >
                        {t('emptyState.retry', { defaultValue: 'Try again' })}
                    </Button>
                }
                description={t('emptyState.radioErrorDescription', {
                    defaultValue: 'Something went wrong while loading your radio stations.',
                })}
                icon="error"
                title={t('emptyState.radioErrorTitle', {
                    defaultValue: "Couldn't load radio stations",
                })}
            />
        );
    }

    if (filteredAndSortedRadioStations.length === 0) {
        // Distinguish "no matches for this search" from "library is empty".
        if (searchTerm) {
            return (
                <EmptyState
                    description={t('emptyState.radioSearchDescription', {
                        defaultValue: "We couldn't find any radio stations matching that search.",
                    })}
                    icon="search"
                    title={t('emptyState.searchTitle', { defaultValue: 'No results' })}
                />
            );
        }

        return (
            <EmptyState
                action={
                    permissions.radio.create ? (
                        <Button
                            onClick={() => openCreateRadioStationModal(server)}
                            variant="filled"
                        >
                            {t('emptyState.createRadioStation', {
                                defaultValue: 'Add radio station',
                            })}
                        </Button>
                    ) : undefined
                }
                description={t('emptyState.radioDescription', {
                    defaultValue: 'Add an internet radio station to start listening.',
                })}
                icon="radio"
                title={t('emptyState.radioTitle', { defaultValue: 'No radio stations yet' })}
            />
        );
    }

    return (
        <Suspense fallback={<RouteSkeleton />}>
            <ScrollArea>
                <Stack p="md">
                    <RadioListItems data={filteredAndSortedRadioStations} />
                </Stack>
            </ScrollArea>
        </Suspense>
    );
};
