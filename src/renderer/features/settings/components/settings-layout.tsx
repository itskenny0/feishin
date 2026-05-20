import type { TFunction } from 'i18next';

import clsx from 'clsx';
import isElectron from 'is-electron';
import { lazy, ReactNode, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    RiArrowLeftLine,
    RiArrowRightSLine,
    RiCommandLine,
    RiEqualizerLine,
    RiKeyboardLine,
    RiSettings4Line,
    RiTerminalBoxLine,
    RiWindowLine,
} from 'react-icons/ri';

import styles from './settings-layout.module.css';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useSettingsStore, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Spinner } from '/@/shared/components/spinner/spinner';

const GeneralTab = lazy(() =>
    import('/@/renderer/features/settings/components/general/general-tab').then((module) => ({
        default: module.GeneralTab,
    })),
);

const PlaybackTab = lazy(() =>
    import('/@/renderer/features/settings/components/playback/playback-tab').then((module) => ({
        default: module.PlaybackTab,
    })),
);

const HotkeysTab = lazy(() =>
    import('/@/renderer/features/settings/components/hotkeys/hotkeys-tab').then((module) => ({
        default: module.HotkeysTab,
    })),
);

const WindowTab = lazy(() =>
    import('/@/renderer/features/settings/components/window/window-tab').then((module) => ({
        default: module.WindowTab,
    })),
);

const AdvancedTab = lazy(() =>
    import('/@/renderer/features/settings/components/advanced/advanced-tab').then((module) => ({
        default: module.AdvancedTab,
    })),
);

interface CategoryDef {
    description: (t: TFunction) => string;
    /** Icon component imported from react-icons. */
    Icon: (props: { size?: string }) => ReactNode;
    id: 'advanced' | 'general' | 'hotkeys' | 'playback' | 'window';
    label: (t: TFunction) => string;
    /**
     * Whether this category should be available in the current host
     * (e.g. window-only-features are hidden in browser/Capacitor).
     */
    visible: () => boolean;
}

const CATEGORIES: CategoryDef[] = [
    {
        description: (t) =>
            t('page.setting.generalDescription', {
                defaultValue: 'Theme, sidebar, home page, scrobbling, paths.',
            }),
        Icon: RiSettings4Line,
        id: 'general',
        label: (t) => t('page.setting.generalTab'),
        visible: () => true,
    },
    {
        description: (t) =>
            t('page.setting.playbackDescription', {
                defaultValue: 'Audio engine, ReplayGain, transitions, queue behaviour.',
            }),
        Icon: RiEqualizerLine,
        id: 'playback',
        label: (t) => t('page.setting.playbackTab'),
        visible: () => true,
    },
    {
        description: (t) =>
            t('page.setting.hotkeysDescription', {
                defaultValue: 'Keyboard bindings for transport, library navigation, ratings.',
            }),
        Icon: RiKeyboardLine,
        id: 'hotkeys',
        label: (t) => t('page.setting.hotkeysTab'),
        visible: () => true,
    },
    {
        description: (t) =>
            t('page.setting.windowDescription', {
                defaultValue: 'Native window chrome, MPRIS, Discord, updates.',
            }),
        Icon: RiWindowLine,
        id: 'window',
        label: (t) => t('page.setting.windowTab'),
        visible: isElectron,
    },
    {
        description: (t) =>
            t('page.setting.advancedDescription', {
                defaultValue: 'Diagnostics, custom CSS, cache, import/export, logs.',
            }),
        Icon: RiTerminalBoxLine,
        id: 'advanced',
        label: (t) => t('page.setting.advanced'),
        visible: () => true,
    },
];

const TAB_CONTENT = {
    advanced: AdvancedTab,
    general: GeneralTab,
    hotkeys: HotkeysTab,
    playback: PlaybackTab,
    window: WindowTab,
} as const;

/**
 * Android-Settings-style layout for the Settings route.
 *
 * On tablet+ (desktop shell width): two-pane layout with a category list on
 * the left and the selected category's content on the right.
 *
 * On phone shell width (<768px): single column. The list is shown at the
 * top level; tapping a category swaps to its detail view, with a back
 * affordance to return to the list. This mirrors Android's drill-down
 * model and avoids the cramped feeling of horizontal tabs on narrow screens.
 *
 * The store's `tab` key is the source of truth for which category is
 * selected; we synchronise it on every selection so the selection survives
 * navigation away from /settings and back.
 */
export const SettingsLayout = () => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();
    const currentTab = useSettingsStore((state) => state.tab);
    const { setSettings } = useSettingsStoreActions();

    const visibleCategories = CATEGORIES.filter((c) => c.visible());

    const handleSelect = useCallback(
        (id: CategoryDef['id']) => setSettings({ tab: id }),
        [setSettings],
    );
    // On phone we treat the "list" view as "no category selected". When a
    // category is genuinely selected and we're on phone, we render the
    // content full-width with a back chevron.
    const phoneShowingDetail = isMobile && Boolean(currentTab);

    return (
        <div
            className={clsx(styles.layout, {
                [styles.mobile]: isMobile,
                [styles.phoneDetail]: phoneShowingDetail,
            })}
        >
            {(!isMobile || !phoneShowingDetail) && (
                <nav
                    aria-label={t('page.setting.categoriesLabel', {
                        defaultValue: 'Setting categories',
                    })}
                    className={styles.sidebar}
                >
                    <ul className={styles.categoryList}>
                        {visibleCategories.map((category) => {
                            const active = !isMobile && category.id === currentTab;
                            const Icon = category.Icon;
                            return (
                                <li key={category.id}>
                                    <button
                                        aria-current={active ? 'page' : undefined}
                                        className={clsx(styles.categoryItem, {
                                            [styles.active]: active,
                                        })}
                                        onClick={() => handleSelect(category.id)}
                                        type="button"
                                    >
                                        <span className={styles.categoryIcon}>
                                            <Icon size="1.4rem" />
                                        </span>
                                        <span className={styles.categoryMeta}>
                                            <span className={styles.categoryLabel}>
                                                {category.label(t)}
                                            </span>
                                            <span className={styles.categoryDescription}>
                                                {category.description(t)}
                                            </span>
                                        </span>
                                        {isMobile && (
                                            <span className={styles.categoryChevron}>
                                                <RiArrowRightSLine size="1.25rem" />
                                            </span>
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </nav>
            )}

            {(!isMobile || phoneShowingDetail) && (
                <section
                    aria-label={t('page.setting.contentLabel', {
                        defaultValue: 'Setting category content',
                    })}
                    className={styles.content}
                >
                    {phoneShowingDetail && (
                        <button
                            aria-label={t('common.back', { defaultValue: 'Back' })}
                            className={styles.backButton}
                            onClick={() => setSettings({ tab: '' })}
                            type="button"
                        >
                            <RiArrowLeftLine size="1.25rem" />
                            <span>
                                {visibleCategories.find((c) => c.id === currentTab)?.label(t) ??
                                    t('page.setting.title', { defaultValue: 'Settings' })}
                            </span>
                            <RiCommandLine
                                aria-hidden
                                className={styles.backHotkeyHint}
                                size="0.9rem"
                            />
                        </button>
                    )}
                    <div className={styles.contentInner}>
                        <Suspense fallback={<Spinner container />}>
                            {(() => {
                                const Component =
                                    TAB_CONTENT[currentTab as keyof typeof TAB_CONTENT] ??
                                    TAB_CONTENT.general;
                                return <Component />;
                            })()}
                        </Suspense>
                    </div>
                </section>
            )}
        </div>
    );
};
