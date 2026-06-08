import debounce from 'lodash/debounce';
import { ChangeEvent, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link, useNavigate, useParams, useSearchParams } from 'react-router';

import {
    ALBUM_ARTIST_TABLE_COLUMNS,
    ALBUM_TABLE_COLUMNS,
    SONG_TABLE_COLUMNS,
} from '/@/renderer/components/item-list/item-table-list/default-columns';
import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { FilterBar } from '/@/renderer/features/shared/components/filter-bar';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import {
    ListConfigMenu,
    SONG_DISPLAY_TYPES,
} from '/@/renderer/features/shared/components/list-config-menu';
import { SearchInput } from '/@/renderer/features/shared/components/search-input';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { AppRoute } from '/@/renderer/router/routes';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button, ButtonGroup } from '/@/shared/components/button/button';
import { Flex } from '/@/shared/components/flex/flex';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface SearchHeaderProps {
    navigationId: string;
}

export const SearchHeader = ({ navigationId }: SearchHeaderProps) => {
    const { t } = useTranslation();
    const { itemType } = useParams() as { itemType: LibraryItem };
    const [searchParams, setSearchParams] = useSearchParams();
    // The Search tab navigates here (the real page). The global command
    // palette — Search…/Create Playlist…/Go to page…/Server commands… — is
    // still mounted globally; on the mobile shell this header is its single
    // entry point (desktop reaches it via hotkeys / app menu, so the button
    // is hidden there to avoid a redundant affordance).
    const isMobileShell = useIsMobileShell();
    const navigate = useNavigate();

    // Memoize the debounced handler so the underlying timer persists across
    // re-renders. A bare `debounce(...)` in the render body produces a fresh
    // function each render — its internal pending-call gets dropped when the
    // URL changes mid-typing, defeating the 200ms buffer.
    const handleSearch = useMemo(
        () =>
            debounce((e: ChangeEvent<HTMLInputElement>) => {
                setSearchParams(
                    { query: e.target.value },
                    { replace: true, state: { navigationId } },
                );
            }, 200),
        [navigationId, setSearchParams],
    );

    // Flush pending input on unmount so a navigation-away while a search is
    // queued doesn't silently drop the user's last keystroke.
    useEffect(() => {
        return () => {
            handleSearch.flush();
        };
    }, [handleSearch]);

    const listConfigMenuProps = {
        [LibraryItem.ALBUM]: {
            listKey: ItemListKey.ALBUM,
            tableColumnsData: ALBUM_TABLE_COLUMNS,
        },
        [LibraryItem.ALBUM_ARTIST]: {
            listKey: ItemListKey.ALBUM_ARTIST,
            tableColumnsData: ALBUM_ARTIST_TABLE_COLUMNS,
        },
        [LibraryItem.SONG]: {
            displayTypes: SONG_DISPLAY_TYPES,
            listKey: ItemListKey.SONG,
            tableColumnsData: SONG_TABLE_COLUMNS,
        },
    };

    return (
        <Stack gap={0}>
            <PageHeader>
                <Flex justify="space-between" w="100%">
                    <LibraryHeaderBar ignoreMaxWidth>
                        <LibraryHeaderBar.Title>
                            {t('common.search', { defaultValue: 'Search' })}
                        </LibraryHeaderBar.Title>
                    </LibraryHeaderBar>
                    <Group gap="xs">
                        <SearchInput
                            defaultValue={searchParams.get('query') || ''}
                            onChange={handleSearch}
                        />
                        {isMobileShell && (
                            <ActionIcon
                                aria-label={t('page.appMenu.commandPalette', {
                                    defaultValue: 'Open command palette',
                                })}
                                icon="keyboard"
                                iconProps={{ size: 'lg' }}
                                onClick={() => navigate(AppRoute.COMMAND)}
                                tooltip={{
                                    label: t('page.appMenu.commandPalette', {
                                        defaultValue: 'Open command palette',
                                    }),
                                    openDelay: 400,
                                }}
                                variant="subtle"
                            />
                        )}
                    </Group>
                </Flex>
            </PageHeader>
            <FilterBar>
                <Flex justify="space-between" w="100%">
                    <ButtonGroup>
                        <Button
                            component={Link}
                            fw={600}
                            replace
                            size="compact-md"
                            state={{ navigationId }}
                            to={{
                                pathname: generatePath(AppRoute.SEARCH, {
                                    itemType: LibraryItem.SONG,
                                }),
                                search: searchParams.toString(),
                            }}
                            variant={itemType === LibraryItem.SONG ? 'filled' : 'default'}
                        >
                            {t('entity.track', { count: 2 })}
                        </Button>
                        <Button
                            component={Link}
                            fw={600}
                            replace
                            size="compact-md"
                            state={{ navigationId }}
                            to={{
                                pathname: generatePath(AppRoute.SEARCH, {
                                    itemType: LibraryItem.ALBUM,
                                }),
                                search: searchParams.toString(),
                            }}
                            variant={itemType === LibraryItem.ALBUM ? 'filled' : 'default'}
                        >
                            {t('entity.album', { count: 2 })}
                        </Button>
                        <Button
                            component={Link}
                            fw={600}
                            replace
                            size="compact-md"
                            state={{ navigationId }}
                            to={{
                                pathname: generatePath(AppRoute.SEARCH, {
                                    itemType: LibraryItem.ALBUM_ARTIST,
                                }),
                                search: searchParams.toString(),
                            }}
                            variant={itemType === LibraryItem.ALBUM_ARTIST ? 'filled' : 'default'}
                        >
                            {t('entity.artist', { count: 2 })}
                        </Button>
                    </ButtonGroup>
                    <ListConfigMenu {...listConfigMenuProps[itemType]} />
                </Flex>
            </FilterBar>
        </Stack>
    );
};
