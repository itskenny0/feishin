import { lazy, Suspense, useState } from 'react';

import { SettingsContent } from '/@/renderer/features/settings/components/settings-content';
import { SettingSearchContext } from '/@/renderer/features/settings/context/search-context';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { Flex } from '/@/shared/components/flex/flex';

const SettingsHeader = lazy(() =>
    import('/@/renderer/features/settings/components/settings-header').then((module) => ({
        default: module.SettingsHeader,
    })),
);

const SettingsRoute = () => {
    const [search, setSearch] = useState('');

    return (
        <AnimatedPage>
            <SettingSearchContext.Provider value={search}>
                <LibraryContainer>
                    <Flex direction="column" h="100%" w="100%">
                        <Suspense fallback={<></>}>
                            <SettingsHeader setSearch={setSearch} />
                        </Suspense>
                        <SettingsContent />
                    </Flex>
                </LibraryContainer>
            </SettingSearchContext.Provider>
        </AnimatedPage>
    );
};

// Wrap with PageErrorBoundary so a broken setting subpanel doesn't blow up
// the whole router. Every other route in this app does the same — Settings
// was the lone outlier and a throw inside (e.g. visualizer-settings, cache
// dashboard) would otherwise bubble to the RouterErrorBoundary and unmount
// the entire shell.
const SettingsRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <SettingsRoute />
        </PageErrorBoundary>
    );
};

export default SettingsRouteWithBoundary;
