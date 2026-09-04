import { t } from 'i18next';
import isElectron from 'is-electron';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import i18n, { languages } from '/@/i18n/i18n';
import { ImageResolutionSettings } from '/@/renderer/features/settings/components/general/art-resolution-settings';
import {
    ArtistPageSectionsSettings,
    ArtistReleaseTypeSettings,
    ArtistSettings,
} from '/@/renderer/features/settings/components/general/artist-settings';
import { FullscreenPlayerSettings } from '/@/renderer/features/settings/components/general/fullscreen-player-settings';
import { HomeSettings } from '/@/renderer/features/settings/components/general/home-settings';
import { PathSettings } from '/@/renderer/features/settings/components/general/path-settings';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import {
    HomeFeatureStyle,
    SideQueueLayout,
    SideQueueType,
    useFontSettings,
    useGeneralSettings,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { type Font, FONT_OPTIONS } from '/@/renderer/types/fonts';
import { FileInput } from '/@/shared/components/file-input/file-input';
import { MultiSelect } from '/@/shared/components/multi-select/multi-select';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Switch } from '/@/shared/components/switch/switch';
import { toast } from '/@/shared/components/toast/toast';
import { FontType } from '/@/shared/types/types';

const localSettings = isElectron() ? window.api.localSettings : null;
const ipc = isElectron() ? window.api.ipc : null;
const utils = isElectron() ? window.api.utils : null;
// Electron 32+ removed file.path, use this which is exposed in preload to get real path
const getPathForFile = isElectron() ? window.api.getPathForFile : null;

const HOME_FEATURE_STYLE_OPTIONS = [
    {
        label: t('setting.homeFeatureStyle', {
            context: 'optionSingle',
        }),
        value: HomeFeatureStyle.SINGLE,
    },
    {
        label: t('setting.homeFeatureStyle', {
            context: 'optionMultiple',
        }),
        value: HomeFeatureStyle.MULTIPLE,
    },
];

const SIDE_QUEUE_OPTIONS = [
    {
        label: t('setting.sidePlayQueueStyle', {
            context: 'optionAttached',
        }),
        value: 'sideQueue',
    },
    {
        label: t('setting.sidePlayQueueStyle', {
            context: 'optionDetached',
        }),
        value: 'sideDrawerQueue',
    },
];

const SIDE_QUEUE_LAYOUT_OPTIONS = [
    {
        label: t('setting.sidePlayQueueLayout', {
            context: 'optionHorizontal',
        }),
        value: 'horizontal',
    },
    {
        label: t('setting.sidePlayQueueLayout', {
            context: 'optionVertical',
        }),
        value: 'vertical',
    },
];

const GRID_GAP_OPTIONS = [
    { label: 'XS', value: 'xs' },
    { label: 'SM', value: 'sm' },
    { label: 'MD', value: 'md' },
    { label: 'LG', value: 'lg' },
    { label: 'XL', value: 'xl' },
];

const GRID_CARD_SIZE_OPTIONS = [
    {
        label: t('setting.gridCardSize', { context: 'optionCompact', defaultValue: 'Compact' }),
        value: 'compact',
    },
    {
        label: t('setting.gridCardSize', { context: 'optionDefault', defaultValue: 'Default' }),
        value: 'default',
    },
    {
        label: t('setting.gridCardSize', { context: 'optionLarge', defaultValue: 'Large' }),
        value: 'large',
    },
];

const GRID_CORNER_RADIUS_OPTIONS = [
    {
        label: t('setting.gridCardCornerRadius', {
            context: 'optionSquare',
            defaultValue: 'Square',
        }),
        value: 'square',
    },
    {
        label: t('setting.gridCardCornerRadius', {
            context: 'optionRoundedSm',
            defaultValue: 'Rounded (small)',
        }),
        value: 'rounded-sm',
    },
    {
        label: t('setting.gridCardCornerRadius', {
            context: 'optionRoundedMd',
            defaultValue: 'Rounded (medium)',
        }),
        value: 'rounded-md',
    },
    {
        label: t('setting.gridCardCornerRadius', {
            context: 'optionRoundedLg',
            defaultValue: 'Rounded (large)',
        }),
        value: 'rounded-lg',
    },
    {
        label: t('setting.gridCardCornerRadius', { context: 'optionPill', defaultValue: 'Pill' }),
        value: 'pill',
    },
];

const GRID_METADATA_ROW_OPTIONS = [
    { label: t('table.column.title', { defaultValue: 'Title' }), value: 'name' },
    {
        label: t('table.column.albumArtist', { defaultValue: 'Album artist' }),
        value: 'albumArtists',
    },
    { label: t('table.column.artist', { defaultValue: 'Artist' }), value: 'artists' },
    { label: t('table.column.duration', { defaultValue: 'Duration' }), value: 'duration' },
    { label: t('table.column.releaseYear', { defaultValue: 'Year' }), value: 'releaseYear' },
    {
        label: t('table.column.releaseDate', { defaultValue: 'Release date' }),
        value: 'releaseDate',
    },
    { label: t('table.column.dateAdded', { defaultValue: 'Date added' }), value: 'createdAt' },
    { label: t('table.column.lastPlayed', { defaultValue: 'Last played' }), value: 'lastPlayedAt' },
    { label: t('table.column.playCount', { defaultValue: 'Play count' }), value: 'playCount' },
    { label: t('table.column.genre', { defaultValue: 'Genres' }), value: 'genres' },
    { label: t('table.column.album', { defaultValue: 'Album' }), value: 'album' },
    { label: t('table.column.songCount', { defaultValue: 'Song count' }), value: 'songCount' },
    { label: t('table.column.albumCount', { defaultValue: 'Album count' }), value: 'albumCount' },
    { label: t('table.column.rating', { defaultValue: 'Rating' }), value: 'rating' },
    { label: t('table.column.favorite', { defaultValue: 'Favorite' }), value: 'userFavorite' },
];

const FONT_TYPES: Font[] = [
    {
        label: i18n.t('setting.fontType', {
            context: 'optionBuiltIn',
        }),
        value: FontType.BUILT_IN,
    },
];

if (window.queryLocalFonts) {
    FONT_TYPES.push({
        label: i18n.t('setting.fontType', { context: 'optionSystem' }),
        value: FontType.SYSTEM,
    });
}

if (isElectron()) {
    FONT_TYPES.push({
        label: i18n.t('setting.fontType', { context: 'optionCustom' }),
        value: FontType.CUSTOM,
    });
}

export const ApplicationSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const fontSettings = useFontSettings();
    const { setSettings } = useSettingsStoreActions();
    const [localFonts, setLocalFonts] = useState<Font[]>([]);

    // const fontList = useMemo(() => {
    //     if (fontSettings.custom) {
    //         return fontSettings.custom.split(/(\\|\/)/g).pop()!;
    //     }
    //     return '';
    // }, [fontSettings.custom]);

    const onFontError = useCallback(
        (file: string) => {
            toast.error({
                message: `${file} is not a valid font file`,
            });

            setSettings({
                font: {
                    ...fontSettings,
                    custom: null,
                },
            });
        },
        [fontSettings, setSettings],
    );

    useEffect(() => {
        if (localSettings) {
            localSettings.fontError(onFontError);

            return () => {
                ipc?.removeAllListeners('custom-font-error');
            };
        }

        return () => {};
    }, [onFontError]);

    useEffect(() => {
        const getFonts = async () => {
            if (
                fontSettings.type === FontType.SYSTEM &&
                localFonts.length === 0 &&
                window.queryLocalFonts
            ) {
                try {
                    // WARNING (Oct 17 2023): while this query is valid for chromium-based
                    // browsers, it is still experimental, and so Typescript will complain
                    const status = await navigator.permissions.query({
                        name: 'local-fonts' as PermissionName,
                    });

                    if (status.state === 'denied') {
                        throw new Error(t('error.localFontAccessDenied'));
                    }

                    const data = await window.queryLocalFonts();
                    setLocalFonts(
                        data.map((font) => ({
                            label: font.fullName,
                            value: font.postscriptName,
                        })),
                    );
                } catch (error) {
                    console.error('Failed to get local fonts', error);
                    toast.error({
                        message: t('error.systemFontError'),
                    });

                    setSettings({
                        font: {
                            ...fontSettings,
                            type: FontType.BUILT_IN,
                        },
                    });
                }
            }
        };
        getFonts();
    }, [fontSettings, localFonts, setSettings, t]);

    const handleChangeLanguage = (e: null | string) => {
        if (!e) return;
        setSettings({
            general: {
                ...settings,
                language: e,
            },
        });
    };

    const options: SettingOption[] = [
        {
            control: (
                <Select
                    data={languages.map((language) => ({
                        label: `${language.label} (${language.value})`,
                        value: language.value,
                    }))}
                    onChange={handleChangeLanguage}
                    value={settings.language}
                />
            ),
            description: t('setting.language', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.language'),
        },
        {
            control: (
                <Select
                    data={FONT_TYPES}
                    onChange={(e) => {
                        if (!e) return;
                        setSettings({
                            font: {
                                ...fontSettings,
                                type: e as FontType,
                            },
                        });
                    }}
                    value={fontSettings.type}
                />
            ),
            description: t('setting.fontType', {
                context: 'description',
            }),
            isHidden: FONT_TYPES.length === 1,
            title: t('setting.fontType'),
        },
        {
            control: (
                <Select
                    data={FONT_OPTIONS}
                    onChange={(e) => {
                        if (!e) return;
                        setSettings({
                            font: {
                                ...fontSettings,
                                builtIn: e,
                            },
                        });
                    }}
                    searchable
                    value={fontSettings.builtIn}
                />
            ),
            description: t('setting.font', { context: 'description' }),
            isHidden: localFonts && fontSettings.type !== FontType.BUILT_IN,
            title: t('setting.font'),
        },
        {
            control: (
                <Select
                    data={localFonts}
                    onChange={(e) => {
                        if (!e) return;
                        setSettings({
                            font: {
                                ...fontSettings,
                                system: e,
                            },
                        });
                    }}
                    searchable
                    value={fontSettings.system}
                    w={300}
                />
            ),
            description: t('setting.font', { context: 'description' }),
            isHidden: !localFonts || fontSettings.type !== FontType.SYSTEM,
            title: t('setting.font'),
        },
        {
            control: (
                <FileInput
                    accept=".ttc,.ttf,.otf,.woff,.woff2"
                    clearable
                    defaultValue={
                        fontSettings.custom
                            ? new File([], fontSettings.custom.split(utils?.separator || '').pop()!)
                            : null
                    }
                    onChange={async (e) => {
                        const custom = e ? getPathForFile?.(e) || null : null;
                        await localSettings?.setSync('local_font_path', custom);
                        setSettings({
                            font: {
                                ...fontSettings,
                                custom,
                            },
                        });
                    }}
                    w={300}
                />
            ),
            description: t('setting.customFontPath', {
                context: 'description',
            }),
            isHidden: !isElectron() || fontSettings.type !== FontType.CUSTOM,
            title: t('setting.customFontPath'),
        },
        {
            control: (
                <NumberInput
                    max={300}
                    min={50}
                    onBlur={(e) => {
                        if (!e) return;
                        const newVal = e.currentTarget.value
                            ? Math.min(Math.max(Number(e.currentTarget.value), 50), 300)
                            : settings.zoomFactor;
                        setSettings({
                            general: {
                                ...settings,
                                zoomFactor: newVal,
                            },
                        });
                        localSettings!.setZoomFactor(newVal);
                    }}
                    value={settings.zoomFactor}
                />
            ),
            description: t('setting.zoom', {
                context: 'description',
            }),
            isHidden: !isElectron(),
            title: t('setting.zoom'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.resume}
                    onChange={(e) => {
                        localSettings?.set('resume', e.target.checked);
                        setSettings({
                            general: {
                                ...settings,
                                resume: e.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.savePlayQueue', {
                context: 'description',
            }),
            isHidden: !isElectron(),
            title: t('setting.savePlayQueue'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.confirmQueueChanges')}
                    checked={settings.confirmQueueChanges}
                    onChange={(event) => {
                        setSettings({
                            general: {
                                ...settings,
                                confirmQueueChanges: event.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.confirmQueueChanges', { context: 'description' }),
            title: t('setting.confirmQueueChanges'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.homeFeature')}
                    defaultChecked={settings.homeFeature}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                homeFeature: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.homeFeature', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.homeFeature'),
        },
        {
            control: (
                <SegmentedControl
                    aria-label={t('setting.homeFeatureStyle')}
                    data={HOME_FEATURE_STYLE_OPTIONS}
                    defaultValue={settings.homeFeatureStyle}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                homeFeatureStyle: e as HomeFeatureStyle,
                            },
                        })
                    }
                />
            ),
            description: t('setting.homeFeatureStyle', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.homeFeatureStyle'),
        },
        {
            control: (
                <Select
                    allowDeselect={false}
                    aria-label={t('setting.homeFeatureContent')}
                    data={[
                        { label: t('page.home.featureVariant_artist'), value: 'artist' },
                        { label: t('page.home.featureVariant_genre'), value: 'genre' },
                        {
                            label: t('page.home.featureVariant_recentlyPlayed'),
                            value: 'recentlyPlayed',
                        },
                        { label: t('page.home.featureVariant_topPlayed'), value: 'topPlayed' },
                        { label: t('page.home.featureVariant_favorites'), value: 'favorites' },
                        { label: t('page.home.featureVariant_unplayed'), value: 'unplayed' },
                        {
                            label: t('page.home.featureVariant_forgottenFavorites'),
                            value: 'forgottenFavorites',
                        },
                        { label: t('page.home.featureVariant_timeMachine'), value: 'timeMachine' },
                        { label: t('page.home.featureVariant_decade'), value: 'decade' },
                        {
                            label: t('page.home.featureVariant_albumOfTheDay'),
                            value: 'albumOfTheDay',
                        },
                        { label: t('page.home.featureVariant_album'), value: 'album' },
                        { label: t('page.home.featureVariant_surpriseMe'), value: 'surpriseMe' },
                    ]}
                    onChange={(next) => {
                        if (!next) return;
                        setSettings({
                            general: {
                                ...settings,
                                homeFeatureContent: next as (typeof settings)['homeFeatureContent'],
                            },
                        });
                    }}
                    value={settings.homeFeatureContent}
                />
            ),
            description: t('setting.homeFeatureContent', { context: 'description' }),
            isHidden: false,
            title: t('setting.homeFeatureContent'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.homeFeelingLucky')}
                    defaultChecked={settings.homeFeelingLucky}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                homeFeelingLucky: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.homeFeelingLucky', { context: 'description' }),
            isHidden: false,
            title: t('setting.homeFeelingLucky'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.homeGreetingVisible', {
                        defaultValue: 'Show greeting',
                    })}
                    defaultChecked={settings.homeGreetingVisible}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                homeGreetingVisible: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.homeGreetingVisible', {
                context: 'description',
                defaultValue: 'Show the time-aware greeting at the top of the home page',
            }),
            isHidden: false,
            title: t('setting.homeGreetingVisible', { defaultValue: 'Show greeting' }),
        },
        {
            control: (
                <NumberInput
                    max={50}
                    min={5}
                    onBlur={(e) => {
                        if (!e) return;
                        const newVal = e.currentTarget.value
                            ? Math.min(Math.max(Number(e.currentTarget.value), 5), 50)
                            : settings.homeCarouselItemsPerPage;
                        setSettings({
                            general: {
                                ...settings,
                                homeCarouselItemsPerPage: newVal,
                            },
                        });
                    }}
                    value={settings.homeCarouselItemsPerPage}
                />
            ),
            description: t('setting.homeCarouselItemsPerPage', {
                context: 'description',
                defaultValue: 'Number of items loaded per page in home carousels',
            }),
            isHidden: false,
            title: t('setting.homeCarouselItemsPerPage', {
                defaultValue: 'Home carousel items per page',
            }),
        },
        {
            control: (
                <NumberInput
                    max={20}
                    min={5}
                    onBlur={(e) => {
                        if (!e) return;
                        const newVal = e.currentTarget.value
                            ? Math.min(Math.max(Number(e.currentTarget.value), 5), 20)
                            : settings.homeFeatureCardSongsPerCard;
                        setSettings({
                            general: {
                                ...settings,
                                homeFeatureCardSongsPerCard: newVal,
                            },
                        });
                    }}
                    value={settings.homeFeatureCardSongsPerCard}
                />
            ),
            description: t('setting.homeFeatureCardSongsPerCard', {
                context: 'description',
                defaultValue: 'Number of songs shown in each home feature card',
            }),
            isHidden: false,
            title: t('setting.homeFeatureCardSongsPerCard', {
                defaultValue: 'Feature card songs per card',
            }),
        },
        {
            control: (
                <Slider
                    defaultValue={settings.homeFeatureCardRotationIntervalSeconds}
                    label={(e) => `${e}s`}
                    max={120}
                    min={5}
                    onChangeEnd={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                homeFeatureCardRotationIntervalSeconds: e,
                            },
                        });
                    }}
                    step={5}
                    w={140}
                />
            ),
            description: t('setting.homeFeatureCardRotationInterval', {
                context: 'description',
                defaultValue: 'Seconds before home feature cards auto-rotate',
            }),
            isHidden: false,
            title: t('setting.homeFeatureCardRotationInterval', {
                defaultValue: 'Feature card rotation interval',
            }),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.albumBackground')}
                    defaultChecked={settings.albumBackground}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                albumBackground: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.albumBackground', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.albumBackground'),
        },
        {
            control: (
                <Slider
                    defaultValue={settings.albumBackgroundBlur}
                    label={(e) => `${e} rem`}
                    max={6}
                    min={0}
                    onChangeEnd={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                albumBackgroundBlur: e,
                            },
                        });
                    }}
                    step={0.5}
                    w={100}
                />
            ),
            description: t('setting.albumBackgroundBlur', {
                context: 'description',
            }),
            isHidden: !settings.albumBackground,
            title: t('setting.albumBackgroundBlur'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.artistBackground')}
                    defaultChecked={settings.artistBackground}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                artistBackground: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.artistBackground', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.artistBackground'),
        },
        {
            control: (
                <Slider
                    defaultValue={settings.artistBackgroundBlur}
                    label={(e) => `${e} rem`}
                    max={6}
                    min={0}
                    onChangeEnd={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                artistBackgroundBlur: e,
                            },
                        });
                    }}
                    step={0.5}
                    w={100}
                />
            ),
            description: t('setting.artistBackgroundBlur', {
                context: 'description',
            }),
            isHidden: !settings.artistBackground,
            title: t('setting.artistBackgroundBlur'),
        },
        {
            control: (
                <Switch
                    aria-label="Toggle using native aspect ratio"
                    defaultChecked={settings.nativeAspectRatio}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                nativeAspectRatio: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.imageAspectRatio', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.imageAspectRatio'),
        },
        {
            control: (
                <Select
                    data={SIDE_QUEUE_OPTIONS}
                    defaultValue={settings.sideQueueType}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                sideQueueType: e as SideQueueType,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.sidePlayQueueStyle', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.sidePlayQueueStyle'),
        },
        {
            control: (
                <SegmentedControl
                    aria-label={t('setting.sidePlayQueueLayout')}
                    data={SIDE_QUEUE_LAYOUT_OPTIONS}
                    defaultValue={settings.sideQueueLayout}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                sideQueueLayout: e as SideQueueLayout,
                            },
                        })
                    }
                />
            ),
            description: t('setting.sidePlayQueueLayout', {
                context: 'description',
            }),
            isHidden: settings.sideQueueType !== 'sideQueue',
            title: t('setting.sidePlayQueueLayout'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.showFavorites}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                showFavorites: e.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.showFavorites', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.showFavorites'),
        },
        {
            control: (
                <Switch
                    defaultChecked={settings.showRatings}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                showRatings: e.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('setting.showRatings', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.showRatings'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.showRatingBadge', { defaultValue: 'Show rating badge' })}
                    defaultChecked={settings.showRatingBadge}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                showRatingBadge: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.showRatingBadge', {
                context: 'description',
                defaultValue: 'Show the star rating badge in the corner of grid card images',
            }),
            isHidden: false,
            title: t('setting.showRatingBadge', { defaultValue: 'Show rating badge' }),
        },
        {
            control: (
                <Select
                    aria-label={t('setting.gridCardSize', { defaultValue: 'Grid card size' })}
                    data={GRID_CARD_SIZE_OPTIONS}
                    onChange={(e) => {
                        if (!e) return;
                        setSettings({
                            general: {
                                ...settings,
                                gridCardSize: e as (typeof settings)['gridCardSize'],
                            },
                        });
                    }}
                    value={settings.gridCardSize}
                />
            ),
            description: t('setting.gridCardSize', {
                context: 'description',
                defaultValue: 'Default density for library grid cards',
            }),
            isHidden: false,
            title: t('setting.gridCardSize', { defaultValue: 'Grid card size' }),
        },
        {
            control: (
                <Select
                    aria-label={t('setting.gridGap', { defaultValue: 'Grid gap' })}
                    data={GRID_GAP_OPTIONS}
                    onChange={(e) => {
                        if (!e) return;
                        setSettings({
                            general: {
                                ...settings,
                                gridGap: e as (typeof settings)['gridGap'],
                            },
                        });
                    }}
                    value={settings.gridGap}
                />
            ),
            description: t('setting.gridGap', {
                context: 'description',
                defaultValue: 'Default spacing between cards in library grids',
            }),
            isHidden: false,
            title: t('setting.gridGap', { defaultValue: 'Grid gap' }),
        },
        {
            control: (
                <Select
                    aria-label={t('setting.gridCardCornerRadius', {
                        defaultValue: 'Grid card corner radius',
                    })}
                    data={GRID_CORNER_RADIUS_OPTIONS}
                    onChange={(e) => {
                        if (!e) return;
                        setSettings({
                            general: {
                                ...settings,
                                gridCardCornerRadius:
                                    e as (typeof settings)['gridCardCornerRadius'],
                            },
                        });
                    }}
                    value={settings.gridCardCornerRadius}
                />
            ),
            description: t('setting.gridCardCornerRadius', {
                context: 'description',
                defaultValue: 'Corner-radius style for library grid cards',
            }),
            isHidden: false,
            title: t('setting.gridCardCornerRadius', { defaultValue: 'Grid card corner radius' }),
        },
        {
            control: (
                <MultiSelect
                    aria-label={t('setting.gridMetadataRows', {
                        defaultValue: 'Grid card metadata rows',
                    })}
                    clearable
                    data={GRID_METADATA_ROW_OPTIONS}
                    onChange={(values) => {
                        setSettings({
                            general: {
                                ...settings,
                                gridMetadataRows: values as (typeof settings)['gridMetadataRows'],
                            },
                        });
                    }}
                    value={settings.gridMetadataRows}
                    width={300}
                />
            ),
            description: t('setting.gridMetadataRows', {
                context: 'description',
                defaultValue:
                    'Fields shown beneath grid card images. Leave empty to use the per-item-type defaults',
            }),
            isHidden: false,
            title: t('setting.gridMetadataRows', { defaultValue: 'Grid card metadata rows' }),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.blurExplicitImages')}
                    defaultChecked={settings.blurExplicitImages}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                blurExplicitImages: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.blurExplicitImages', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.blurExplicitImages'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.enableGridMultiSelect')}
                    defaultChecked={settings.enableGridMultiSelect}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                enableGridMultiSelect: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.enableGridMultiSelect', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.enableGridMultiSelect'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.playerbarOpenDrawer')}
                    defaultChecked={settings.playerbarOpenDrawer}
                    onChange={(e) =>
                        setSettings({
                            general: {
                                ...settings,
                                playerbarOpenDrawer: e.currentTarget.checked,
                            },
                        })
                    }
                />
            ),
            description: t('setting.playerbarOpenDrawer', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.playerbarOpenDrawer'),
        },
        {
            control: (
                <NumberInput
                    max={120}
                    min={0}
                    onBlur={(e) => {
                        const rawValue = e.currentTarget.value;

                        const newVal = Math.min(Math.max(Number(rawValue), 0), 120);

                        setSettings({
                            general: {
                                ...settings,
                                fullscreenAutoOpenTimeout: newVal,
                            },
                        });
                    }}
                    placeholder={t('common.none')}
                    value={settings.fullscreenAutoOpenTimeout}
                />
            ),
            description: t('setting.fullscreenAutoOpenTimeout', {
                context: 'description',
            }),
            isHidden: false,
            title: t('setting.fullscreenAutoOpenTimeout'),
        },
        {
            control: (
                <Switch
                    aria-label={t('setting.autosave')}
                    defaultChecked={settings.autoSave.enabled}
                    onChange={(e) => {
                        setSettings({
                            general: {
                                ...settings,
                                autoSave: {
                                    ...settings.autoSave,
                                    enabled: e.currentTarget.checked,
                                },
                            },
                        });
                    }}
                />
            ),
            description: t('setting.autosave', {
                context: 'description',
            }),
            title: t('setting.autosave'),
        },
        {
            control: (
                <NumberInput
                    min={1}
                    onBlur={(e) => {
                        if (!e) return;
                        const newVal = e.currentTarget.value
                            ? Math.max(Number(e.currentTarget.value), 1)
                            : settings.autoSave.count;
                        setSettings({
                            general: {
                                ...settings,
                                autoSave: {
                                    ...settings.autoSave,
                                    count: newVal,
                                },
                            },
                        });
                    }}
                    value={settings.autoSave.count}
                />
            ),
            description: t('setting.autosaveCount', {
                context: 'description',
            }),
            isHidden: !settings.autoSave.enabled,
            title: t('setting.autosaveCount'),
        },
    ];

    return (
        <SettingsSection
            extra={
                <>
                    <ImageResolutionSettings />
                    <HomeSettings />
                    <ArtistSettings />
                    <ArtistPageSectionsSettings />
                    <ArtistReleaseTypeSettings />
                    <FullscreenPlayerSettings />
                    <PathSettings />
                </>
            }
            options={options}
            title={t('page.setting.application')}
        />
    );
});
