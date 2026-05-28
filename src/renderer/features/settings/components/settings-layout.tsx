import type { TFunction } from 'i18next';

import { Capacitor } from '@capacitor/core';
import clsx from 'clsx';
import isElectron from 'is-electron';
import { ReactNode, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    RiArrowLeftLine,
    RiArrowRightSLine,
    RiBroadcastLine,
    RiEqualizerLine,
    RiKeyboardLine,
    RiSettings4Line,
    RiTerminalBoxLine,
    RiWindowLine,
} from 'react-icons/ri';

import styles from './settings-layout.module.css';

import { SETTINGS_SUBPAGES, SubpageDef } from '/@/renderer/features/settings/subpages';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useCurrentServer } from '/@/renderer/store/auth.store';
import { useSettingsStore, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Spinner } from '/@/shared/components/spinner/spinner';

/*
 * "Is this a touch-first, no-keyboard device" detector. We can't use
 * the React `useIsTouch` hook in the CATEGORIES array because that
 * lives at module scope. matchMedia is synchronous + cheap, so we
 * sample it once per render where needed (inside the visible() lambdas).
 */
const isTouchOnlyDevice = () => {
    if (typeof window === 'undefined') return false;
    if (Capacitor.getPlatform() === 'android' || Capacitor.getPlatform() === 'ios') {
        return true;
    }
    return window.matchMedia('(pointer: coarse)').matches;
};

interface CategoryDef {
    description: (t: TFunction) => string;
    /** Icon component imported from react-icons. */
    Icon: (props: { size?: string }) => ReactNode;
    id: 'advanced' | 'connect' | 'general' | 'hotkeys' | 'playback' | 'window';
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
            t('page.setting.connectDescription', {
                defaultValue:
                    'Jellyfin Connect remote-play, peer MQTT sync, and the local library cache.',
            }),
        Icon: RiBroadcastLine,
        id: 'connect',
        label: (t) => t('page.setting.connectTab', { defaultValue: 'Sync & Connect' }),
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
        visible: () => !isTouchOnlyDevice(),
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

/**
 * Three-level drill-down settings UI, modelled on Android's Settings app.
 *
 * Level 1 — Categories. Top-level grouping (General, Playback, Hotkeys,
 *           Window, Advanced).
 * Level 2 — Subpages. Each category exposes a list of focused subpages
 *           (Theme, Home, Sidebar, … under General). The user picks one
 *           instead of scrolling through a single tall page of every
 *           setting in the category at once.
 * Level 3 — Subpage content. The actual setting controls. Subpages may
 *           still use collapsibles internally where settings naturally
 *           group (e.g. "Advanced" sub-section inside Theme), but the
 *           top-level "every section in this category" collapsible
 *           list is gone.
 *
 * Desktop keeps the left rail of categories visible; the right pane
 * swaps between subpages-list and selected-subpage. Mobile drills down
 * fully — back chevrons walk the user up one level at a time, matching
 * the platform's standard Settings flow.
 */
export const SettingsLayout = () => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();
    const currentTab = useSettingsStore((state) => state.tab);
    const currentSubpage = useSettingsStore((state) => state.tabSubpage);
    const { setSettings } = useSettingsStoreActions();
    const server = useCurrentServer();

    const visibleCategories = CATEGORIES.filter((c) => c.visible());
    const subpagesForTab = (SETTINGS_SUBPAGES[currentTab] ?? []).filter(
        (s) => !s.visible || s.visible(server),
    );
    const selectedSubpage: SubpageDef | undefined = subpagesForTab.find(
        (s) => s.id === currentSubpage,
    );

    const handleSelectCategory = useCallback(
        (id: CategoryDef['id']) => setSettings({ tab: id, tabSubpage: '' }),
        [setSettings],
    );

    const handleSelectSubpage = useCallback(
        (subpageId: string) => setSettings({ tabSubpage: subpageId }),
        [setSettings],
    );

    const handleBack = useCallback(() => {
        // Drill back one level: subpage → subpages-list → category list (mobile only)
        if (currentSubpage) {
            setSettings({ tabSubpage: '' });
        } else if (isMobile) {
            setSettings({ tab: '' });
        }
    }, [currentSubpage, isMobile, setSettings]);

    const onMobileTopLevel = isMobile && !currentTab;
    const onMobileSubpageList = isMobile && Boolean(currentTab) && !currentSubpage;
    const onMobileSubpage = isMobile && Boolean(currentTab) && Boolean(currentSubpage);

    const showCategoryRail = !isMobile || onMobileTopLevel;
    const showContent = !isMobile || onMobileSubpageList || onMobileSubpage;

    return (
        <div
            className={clsx(styles.layout, {
                [styles.mobile]: isMobile,
                [styles.phoneDetail]: !onMobileTopLevel && isMobile,
            })}
        >
            {showCategoryRail && (
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
                                        onClick={() => handleSelectCategory(category.id)}
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

            {showContent && (
                <section
                    aria-label={t('page.setting.contentLabel', {
                        defaultValue: 'Setting category content',
                    })}
                    className={styles.content}
                >
                    {(onMobileSubpageList || onMobileSubpage || (!isMobile && currentSubpage)) && (
                        <button
                            aria-label={t('common.back', { defaultValue: 'Back' })}
                            className={styles.backButton}
                            onClick={handleBack}
                            type="button"
                        >
                            <RiArrowLeftLine size="1.25rem" />
                            <span>
                                {selectedSubpage
                                    ? selectedSubpage.label(t)
                                    : (visibleCategories
                                          .find((c) => c.id === currentTab)
                                          ?.label(t) ??
                                      t('page.setting.title', { defaultValue: 'Settings' }))}
                            </span>
                        </button>
                    )}
                    <div className={styles.contentInner}>
                        {selectedSubpage ? (
                            <Suspense fallback={<Spinner container />}>
                                <selectedSubpage.Component />
                            </Suspense>
                        ) : (
                            <SubpageList onSelect={handleSelectSubpage} subpages={subpagesForTab} />
                        )}
                    </div>
                </section>
            )}
        </div>
    );
};

interface SubpageListProps {
    onSelect: (id: string) => void;
    subpages: SubpageDef[];
}

const SubpageList = ({ onSelect, subpages }: SubpageListProps) => {
    const { t } = useTranslation();

    if (subpages.length === 0) {
        return (
            <p className={styles.emptyCategory}>
                {t('page.setting.emptyCategory', {
                    defaultValue: 'No options available for this category in the current build.',
                })}
            </p>
        );
    }

    return (
        <ul className={styles.subpageList}>
            {subpages.map((subpage) => {
                const Icon = subpage.Icon;
                return (
                    <li key={subpage.id}>
                        <button
                            className={styles.subpageRow}
                            onClick={() => onSelect(subpage.id)}
                            type="button"
                        >
                            <span className={styles.subpageIcon}>
                                <Icon size="1.25rem" />
                            </span>
                            <span className={styles.subpageMeta}>
                                <span className={styles.subpageLabel}>{subpage.label(t)}</span>
                                {subpage.description && (
                                    <span className={styles.subpageDescription}>
                                        {subpage.description(t)}
                                    </span>
                                )}
                            </span>
                            <span className={styles.subpageChevron}>
                                <RiArrowRightSLine size="1.25rem" />
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
};
