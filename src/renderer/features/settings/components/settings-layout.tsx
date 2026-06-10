import type { TFunction } from 'i18next';

import { Capacitor } from '@capacitor/core';
import clsx from 'clsx';
import isElectron from 'is-electron';
import { ReactNode, Suspense, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    RiArrowLeftLine,
    RiArrowRightSLine,
    RiBroadcastLine,
    RiEqualizerLine,
    RiKeyboardLine,
    RiSearchLine,
    RiSettings4Line,
    RiTerminalBoxLine,
    RiWindowLine,
} from 'react-icons/ri';

import styles from './settings-layout.module.css';

import { SETTINGS_SUBPAGES, SubpageDef } from '/@/renderer/features/settings/subpages';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useCurrentServer } from '/@/renderer/store/auth.store';
import {
    usePeerSyncSettings,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
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

interface SearchHit {
    category: CategoryDef;
    subpage: SubpageDef;
}

/**
 * "Console index" settings shell — a three-level drill-down redesigned as a
 * studio-desk index:
 *
 * Level 1 — Categories. A numbered rail (01–06) with a sliding accent
 *           indicator; each entry carries an icon, label and a one-line
 *           description.
 * Level 2 — Subpages. A staggered card grid under an oversized watermark
 *           headline of the category name.
 * Level 3 — Subpage content. The actual setting controls.
 *
 * A global search above the rail matches every subpage across every visible
 * category and jumps straight to it — no need to know which category holds
 * "ReplayGain". Desktop keeps the rail visible; mobile drills down fully
 * with back chevrons, matching the platform Settings convention. All colour
 * comes from the theme tokens so the shell tracks every app theme.
 */
export const SettingsLayout = () => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();
    const currentTab = useSettingsStore((state) => state.tab);
    const currentSubpage = useSettingsStore((state) => state.tabSubpage);
    const { setSettings } = useSettingsStoreActions();
    const server = useCurrentServer();
    const [query, setQuery] = useState('');

    const visibleCategories = CATEGORIES.filter((c) => c.visible());
    const subpagesForTab = (SETTINGS_SUBPAGES[currentTab] ?? []).filter(
        (s) => !s.visible || s.visible(server),
    );
    const selectedSubpage: SubpageDef | undefined = subpagesForTab.find(
        (s) => s.id === currentSubpage,
    );

    // On mobile, entering Settings must always land on the top-level category
    // list — never deep-linked into the last-open subpage. `tab`/`tabSubpage`
    // live in the *persisted* settings store, so without this reset they
    // survive both a route change (leave Settings → come back) and an app
    // relaunch, dropping the user straight back into a Level-3 subpage. Desktop
    // keeps its persisted position because the category rail is always visible
    // there, so there's no "lost my place" surprise to undo. useLayoutEffect so
    // the reset lands before paint (no one-frame flash of the stale subpage).
    // Mount-scoped by design: this models "entered Settings", not "viewport
    // became mobile" — the mobile route remounts SettingsLayout on every entry.
    useLayoutEffect(() => {
        if (isMobile) {
            setSettings({ tab: '', tabSubpage: '' });
        }
    }, [isMobile, setSettings]);

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

    // Global subpage search: matches label + description across every visible
    // category, so "replay" lands on Playback → ReplayGain without knowing
    // the taxonomy. Selecting a hit jumps both drill-down levels at once.
    const trimmedQuery = query.trim().toLocaleLowerCase();
    const searchHits: SearchHit[] = useMemo(() => {
        if (!trimmedQuery) return [];
        const hits: SearchHit[] = [];
        for (const category of visibleCategories) {
            const subpages = (SETTINGS_SUBPAGES[category.id] ?? []).filter(
                (s) => !s.visible || s.visible(server),
            );
            for (const subpage of subpages) {
                const haystack = `${subpage.label(t)} ${subpage.description?.(t) ?? ''} ${category.label(t)}`;
                if (haystack.toLocaleLowerCase().includes(trimmedQuery)) {
                    hits.push({ category, subpage });
                }
            }
        }
        return hits;
        // visibleCategories is derived from a module constant + visible();
        // its identity churns per render but its contents are stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trimmedQuery, server, t]);

    const handleSelectHit = useCallback(
        (hit: SearchHit) => {
            setQuery('');
            setSettings({ tab: hit.category.id, tabSubpage: hit.subpage.id });
        },
        [setSettings],
    );

    const onMobileTopLevel = isMobile && !currentTab;
    const onMobileSubpageList = isMobile && Boolean(currentTab) && !currentSubpage;
    const onMobileSubpage = isMobile && Boolean(currentTab) && Boolean(currentSubpage);

    const showCategoryRail = !isMobile || onMobileTopLevel;
    const showContent = !isMobile || onMobileSubpageList || onMobileSubpage;
    const searching = trimmedQuery.length > 0;

    const activeCategory = visibleCategories.find((c) => c.id === currentTab);

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
                    <div className={styles.searchBox}>
                        <RiSearchLine aria-hidden className={styles.searchIcon} size="1rem" />
                        <input
                            aria-label={t('page.setting.searchSettings', {
                                defaultValue: 'Search settings',
                            })}
                            className={styles.searchInput}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('page.setting.searchSettings', {
                                defaultValue: 'Search settings',
                            })}
                            spellCheck={false}
                            type="search"
                            value={query}
                        />
                    </div>

                    {searching ? (
                        <ul aria-label={t('common.search')} className={styles.searchResults}>
                            {searchHits.length === 0 && (
                                <li className={styles.searchEmpty}>
                                    {t('page.setting.searchNoResults', {
                                        defaultValue: 'Nothing matches',
                                    })}
                                </li>
                            )}
                            {searchHits.map((hit) => {
                                const Icon = hit.subpage.Icon;
                                return (
                                    <li key={`${hit.category.id}:${hit.subpage.id}`}>
                                        <button
                                            className={styles.searchHit}
                                            onClick={() => handleSelectHit(hit)}
                                            type="button"
                                        >
                                            <span className={styles.searchHitIcon}>
                                                <Icon size="1.05rem" />
                                            </span>
                                            <span className={styles.searchHitMeta}>
                                                <span className={styles.searchHitLabel}>
                                                    {hit.subpage.label(t)}
                                                </span>
                                                <span className={styles.searchHitCrumb}>
                                                    {hit.category.label(t)}
                                                </span>
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <ul className={styles.categoryList}>
                            {visibleCategories.map((category, index) => {
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
                                            <span className={styles.categoryIndex}>
                                                {String(index + 1).padStart(2, '0')}
                                            </span>
                                            <span className={styles.categoryIcon}>
                                                <Icon size="1.25rem" />
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
                    )}
                </nav>
            )}

            {showContent && (
                <section
                    aria-label={t('page.setting.contentLabel', {
                        defaultValue: 'Setting category content',
                    })}
                    className={styles.content}
                >
                    {activeCategory && !selectedSubpage && (
                        <span aria-hidden className={styles.watermark}>
                            {activeCategory.label(t)}
                        </span>
                    )}
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
                            <>
                                {currentTab === 'connect' && (
                                    <ConnectCategoryPrelude
                                        onLaunchWizard={() => handleSelectSubpage('wizard')}
                                    />
                                )}
                                <SubpageList
                                    key={currentTab}
                                    onSelect={handleSelectSubpage}
                                    subpages={subpagesForTab}
                                />
                            </>
                        )}
                    </div>
                </section>
            )}
        </div>
    );
};

interface ConnectCategoryPreludeProps {
    onLaunchWizard: () => void;
}

/**
 * Top-of-page banner for the Sync & Connect category. Until the user has
 * finished the setup wizard the banner is a prominent call-to-action; once
 * onboarded it's a compact reassurance with a re-run shortcut.
 */
const ConnectCategoryPrelude = ({ onLaunchWizard }: ConnectCategoryPreludeProps) => {
    const { t } = useTranslation();
    const peerSync = usePeerSyncSettings();

    if (!peerSync.onboarded) {
        return (
            <div className={styles.preludeCallout} data-tone="primary">
                <div className={styles.preludeText}>
                    <p className={styles.preludeTitle}>
                        {t('page.setting.connectGetStartedTitle', {
                            defaultValue: 'Set up Sync & Connect',
                        })}
                    </p>
                    <p className={styles.preludeBody}>
                        {t('page.setting.connectGetStartedBody', {
                            defaultValue:
                                'Tell Feishin how to talk to other devices and the rest of this category becomes useful.',
                        })}
                    </p>
                </div>
                <button className={styles.preludeAction} onClick={onLaunchWizard} type="button">
                    {t('page.setting.connectGetStartedCta', {
                        defaultValue: 'Open setup wizard',
                    })}
                </button>
            </div>
        );
    }

    return (
        <div className={styles.preludeCallout} data-tone="muted">
            <div className={styles.preludeText}>
                <p className={styles.preludeBody}>
                    {peerSync.jellyfinRemoteEnabled
                        ? t('page.setting.connectOnboardedBody', {
                              defaultValue:
                                  'Sync & Connect is on. Disable it from the page below or fine-tune what shows up in the player UI.',
                          })
                        : t('page.setting.connectOnboardedDisabledBody', {
                              defaultValue:
                                  'Sync & Connect is set up but turned off. Re-enable it from the page below.',
                          })}
                </p>
            </div>
            <button className={styles.preludeActionMuted} onClick={onLaunchWizard} type="button">
                {t('page.setting.connectReRunWizard', {
                    defaultValue: 'Re-run setup',
                })}
            </button>
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
        <ul className={styles.subpageGrid}>
            {subpages.map((subpage, index) => {
                const Icon = subpage.Icon;
                return (
                    <li
                        className={styles.subpageCell}
                        key={subpage.id}
                        style={{ animationDelay: `${index * 35}ms` }}
                    >
                        <button
                            className={styles.subpageCard}
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
