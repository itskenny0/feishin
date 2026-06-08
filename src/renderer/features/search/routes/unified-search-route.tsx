import debounce from 'lodash/debounce';
import { ChangeEvent, useEffect, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router';

import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { UnifiedSearchResults } from '/@/renderer/features/search/components/unified-search-results';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { SearchInput } from '/@/renderer/features/shared/components/search-input';
import { Flex } from '/@/shared/components/flex/flex';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';

/**
 * The unified search RESULTS page mounted at `/search` (index). It owns the
 * search input (writing `?query=`) and renders the responsive multi-section
 * results below. The per-entity "see all" lists live at `/search/:itemType`
 * (the legacy SearchRoute); the mobile quick-search command palette lives at
 * `/command`.
 */
const UnifiedSearchRoute = () => {
    const { t } = useTranslation();
    const { state: locationState } = useLocation();
    const localNavigationId = useId();
    const navigationId = locationState?.navigationId || localNavigationId;
    const [searchParams, setSearchParams] = useSearchParams();

    // Memoized debounce so the 200ms buffer survives re-renders (a fresh
    // debounce() per render drops the pending call when the URL changes
    // mid-typing). Mirrors search-header.tsx.
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

    useEffect(() => {
        return () => {
            handleSearch.flush();
        };
    }, [handleSearch]);

    return (
        <AnimatedPage key={`search-${navigationId}`}>
            <Stack gap={0} h="100%">
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
                        </Group>
                    </Flex>
                </PageHeader>
                <UnifiedSearchResults />
            </Stack>
        </AnimatedPage>
    );
};

const UnifiedSearchRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <UnifiedSearchRoute />
        </PageErrorBoundary>
    );
};

export default UnifiedSearchRouteWithBoundary;
