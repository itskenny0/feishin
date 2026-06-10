import { memo, useMemo } from 'react';

import { DraggableItems } from '/@/renderer/features/settings/components/general/draggable-items';
import {
    DEFAULT_HOME_ITEM_ORDER,
    HomeItem,
    resolveHomeSections,
    SortableItem,
    useGeneralSettings,
    useSettingsStoreActions,
} from '/@/renderer/store';

/**
 * Translation-key label for each live home section. The hero/greeting row is
 * deliberately absent — it stays always-on and has its own toggles in
 * Settings → General (Show greeting / I'm feeling lucky).
 */
const HOME_ITEM_LABELS: Record<HomeItem, string> = {
    [HomeItem.ARTISTS]: 'page.home.shelfArtists',
    [HomeItem.GENRES]: 'page.home.genres',
    // Legacy ids: never surfaced in the panel (DraggableItems filters by
    // itemLabels), kept here only so the Record stays exhaustive.
    [HomeItem.LIBRARY_STATS]: 'page.home.libraryStats_title',
    [HomeItem.MOST_PLAYED]: 'page.home.mostPlayed',
    [HomeItem.NEW_SINCE_LAST_VISIT]: 'page.home.newSinceLastVisit_settingLabel',
    [HomeItem.PINNED]: 'page.home.pinned',
    [HomeItem.PLAYLISTS]: 'page.home.shelfPlaylists',
    [HomeItem.QUICK_FILTERS]: 'page.home.quickFilters_title',
    [HomeItem.QUICK_PICKS]: 'page.home.quickPicks_title',
    [HomeItem.RANDOM]: 'page.home.explore',

    [HomeItem.RECENTLY_ADDED]: 'page.home.newlyAdded',
    [HomeItem.RECENTLY_PLAYED]: 'page.home.recentlyPlayed',
    [HomeItem.RECENTLY_RELEASED]: 'page.home.recentlyReleased',
};

// Only live sections are listed, in canonical render order.
const HOME_ITEMS: Array<[string, string]> = DEFAULT_HOME_ITEM_ORDER.map((id) => [
    id,
    HOME_ITEM_LABELS[id],
]);

export const HomeSettings = memo(() => {
    const { homeItems } = useGeneralSettings();
    const { setHomeItems } = useSettingsStoreActions();

    // Reconcile the persisted config against the current live sections so the
    // panel reflects reality even without a settings migration: legacy ids are
    // dropped and any newly-added section appears (enabled) in canonical order.
    const resolvedItems = useMemo(() => resolveHomeSections(homeItems), [homeItems]);

    return (
        <DraggableItems
            description="setting.homeConfiguration"
            itemLabels={HOME_ITEMS}
            items={resolvedItems as SortableItem<HomeItem>[]}
            setItems={setHomeItems}
            title="setting.homeConfiguration"
        />
    );
});
