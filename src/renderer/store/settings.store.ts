import isElectron from 'is-electron';
import cloneDeep from 'lodash/cloneDeep';
import mergeWith from 'lodash/mergeWith';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';
import { generatePath } from 'react-router';
import { z } from 'zod';
import { devtools, persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import i18n from '/@/i18n/i18n';
import {
    ALBUM_ARTIST_TABLE_COLUMNS,
    ALBUM_TABLE_COLUMNS,
    GENRE_TABLE_COLUMNS,
    pickGridRows,
    pickTableColumns,
    PLAYLIST_SONG_TABLE_COLUMNS,
    PLAYLIST_TABLE_COLUMNS,
    SONG_TABLE_COLUMNS,
} from '/@/renderer/components/item-list/item-table-list/default-columns';
import { audiomotionanalyzerPresets } from '/@/renderer/features/visualizer/components/audiomotionanalyzer/presets';
import { AppRoute } from '/@/renderer/router/routes';
import { getEnvSettingsOverrides } from '/@/renderer/store/env-settings-overrides';
import { mergeOverridingColumns } from '/@/renderer/store/utils';
import { FontValueSchema } from '/@/renderer/types/fonts';
import { randomString } from '/@/renderer/utils';
import { sanitizeCss } from '/@/renderer/utils/sanitize';
import { AppTheme } from '/@/shared/themes/app-theme-types';
import { LibraryItem, LyricSource, SavedCollection } from '/@/shared/types/domain-types';
import {
    FontType,
    ItemListKey,
    ListDisplayType,
    ListPaginationType,
    Platform,
    Play,
    PlayerType,
    TableColumn,
} from '/@/shared/types/types';

const utils = isElectron() ? window.api.utils : null;

type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
};

const deepMergeIntoState = <T extends Record<string, any>>(
    state: T,
    updates: DeepPartial<T>,
): void => {
    // Walk only the keys present in `updates`. Arrays in source replace the
    // target entirely; plain objects recurse; everything else assigns. This
    // mirrors the previous lodash mergeWith customizer but avoids walking the
    // unrelated parts of the state tree on each settings write.
    for (const key in updates) {
        if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
        if (key === 'actions') continue;

        const srcValue = (updates as any)[key];
        const targetValue = (state as any)[key];

        if (Array.isArray(srcValue)) {
            (state as any)[key] = srcValue;
        } else if (isPlainObject(srcValue) && isPlainObject(targetValue)) {
            deepMergeIntoState(targetValue, srcValue);
        } else if (srcValue !== undefined) {
            (state as any)[key] = srcValue;
        }
    }
};

const HomeItemSchema = z.enum([
    'genres',
    'libraryStats',
    'mostPlayed',
    'newSinceLastVisit',
    'quickFilters',
    'random',
    'recentlyAdded',
    'recentlyPlayed',
    'recentlyReleased',
]);

const PlayerItemSchema = z.enum([
    'bit_depth',
    'bit_rate',
    'bpm',
    'disc_number',
    'sample_rate',
    'track_number',
    'codec',
    'release_year',
    'release_type',
    'release_date',
    'genres',
]);

const ArtistItemSchema = z.enum([
    'biography',
    'compilations',
    'favoriteSongs',
    'recentAlbums',
    'similarArtists',
    'topSongs',
]);

const ArtistReleaseTypeItemSchema = z.enum([
    'releaseTypeAlbum',
    'releaseTypeEp',
    'releaseTypeSingle',
    'releaseTypeBroadcast',
    'releaseTypeOther',
    'releaseTypeCompilation',
    'appearsOn',
    'releaseTypeAudioDrama',
    'releaseTypeAudiobook',
    'releaseTypeDemo',
    'releaseTypeDjMix',
    'releaseTypeFieldRecording',
    'releaseTypeInterview',
    'releaseTypeLive',
    'releaseTypeMixtapeStreet',
    'releaseTypeRemix',
    'releaseTypeSoundtrack',
    'releaseTypeSpokenWord',
]);

const BindingActionsSchema = z.enum([
    'browserBack',
    'browserForward',
    'favoriteCurrentAdd',
    'favoriteCurrentRemove',
    'favoriteCurrentToggle',
    'favoritePreviousAdd',
    'favoritePreviousRemove',
    'favoritePreviousToggle',
    'globalSearch',
    'localSearch',
    'volumeMute',
    'navigateHome',
    'next',
    'pause',
    'play',
    'playPause',
    'previous',
    'rate0',
    'rate1',
    'rate2',
    'rate3',
    'rate4',
    'rate5',
    'toggleShuffle',
    'skipBackward',
    'skipForward',
    'stop',
    'toggleFullscreenPlayer',
    'toggleQueue',
    'toggleRepeat',
    'volumeDown',
    'volumeUp',
    'zoomIn',
    'zoomOut',
    'listPlayDefault',
    'listPlayNow',
    'listPlayNext',
    'listPlayLast',
    'listNavigateToPage',
    'listShowPlayingSong',
]);

const DiscordDisplayTypeSchema = z.enum(['artist', 'feishin', 'song']);

const DiscordLinkTypeSchema = z.enum(['last_fm', 'musicbrainz', 'musicbrainz_last_fm', 'none']);

const GenreTargetSchema = z.enum(['album', 'track']);

const PlaylistTargetSchema = z.enum(['album', 'track']);

const SideQueueTypeSchema = z.enum(['sideDrawerQueue', 'sideQueue']);
const SideQueueLayoutSchema = z.enum(['horizontal', 'vertical']);

const TrackmapStyleSchema = z.enum(['glow']);

const SidebarPanelTypeSchema = z.enum(['queue', 'lyrics', 'visualizer']);

const SidebarPlaylistFolderViewSchema = z.enum(['single', 'tree', 'navigation']);

const SidebarPlaylistModeSchema = z.enum(['compact', 'expanded']);

const CollectionSchema = z.object({
    filterQueryString: z.string(),
    id: z.string(),
    name: z.string(),
    type: z.enum([LibraryItem.ALBUM, LibraryItem.SONG]),
});

const SidebarItemTypeSchema = z.object({
    disabled: z.boolean(),
    id: z.string(),
    label: z.string(),
    route: z.union([z.nativeEnum(AppRoute), z.string()]),
});

const SortableItemSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
    z.object({
        disabled: z.boolean(),
        id: itemSchema,
    });

const ItemTableListColumnConfigSchema = z.object({
    align: z.enum(['center', 'end', 'start']),
    autoSize: z.boolean().optional(),
    id: z.nativeEnum(TableColumn),
    isEnabled: z.boolean(),
    pinned: z.union([z.literal('left'), z.literal('right'), z.literal(null)]),
    width: z.number(),
});

export type ItemTableListColumnConfig = z.infer<typeof ItemTableListColumnConfigSchema>;

const ItemGridListRowConfigSchema = z.object({
    align: z.enum(['center', 'end', 'start']),
    id: z.nativeEnum(TableColumn),
    isEnabled: z.boolean(),
});

export type ItemGridListRowConfig = z.infer<typeof ItemGridListRowConfigSchema>;

const ItemTableListPropsSchema = z.object({
    autoFitColumns: z.boolean(),
    columns: z.array(ItemTableListColumnConfigSchema),
    enableAlternateRowColors: z.boolean(),
    enableHeader: z.boolean(),
    enableHorizontalBorders: z.boolean(),
    enableRowHoverHighlight: z.boolean(),
    enableVerticalBorders: z.boolean(),
    size: z.enum(['compact', 'default', 'large']),
});

const ItemDetailListPropsSchema = z.object({
    columns: z.array(ItemTableListColumnConfigSchema),
    enableAlternateRowColors: z.boolean(),
    enableHeader: z.boolean(),
    enableHorizontalBorders: z.boolean(),
    enableRowHoverHighlight: z.boolean(),
    enableVerticalBorders: z.boolean(),
    size: z.enum(['compact', 'default', 'large']),
});

const ItemListConfigSchema = z.object({
    detail: ItemDetailListPropsSchema.optional(),
    display: z.nativeEnum(ListDisplayType),
    grid: z.object({
        itemGap: z.enum(['lg', 'md', 'sm', 'xl', 'xs']),
        itemsPerRow: z.number(),
        itemsPerRowEnabled: z.boolean(),
        rows: z.array(ItemGridListRowConfigSchema),
        size: z.enum(['compact', 'default', 'large']),
    }),
    itemsPerPage: z.number(),
    pagination: z.nativeEnum(ListPaginationType),
    table: ItemTableListPropsSchema,
});

const TranscodingConfigSchema = z.object({
    bitrate: z.number().optional(),
    enabled: z.boolean(),
    format: z.string().optional(),
});

const MpvSettingsSchema = z.object({
    audioExclusiveMode: z.enum(['no', 'yes']),
    audioFormat: z.enum(['float', 's16', 's32']).optional(),
    audioSampleRateHz: z.number().optional(),
    gaplessAudio: z.enum(['no', 'weak', 'yes']),
    replayGainClip: z.boolean(),
    replayGainFallbackDB: z.number().optional(),
    replayGainMode: z.enum(['album', 'no', 'track']),
    replayGainPreampDB: z.number().optional(),
});

const CssSettingsSchema = z.object({
    content: z.string().transform((val) => sanitizeCss(`<style>${val}`)),
    enabled: z.boolean(),
});

const DiscordSettingsSchema = z.object({
    clientId: z.string(),
    displayType: DiscordDisplayTypeSchema,
    enabled: z.boolean(),
    linkType: DiscordLinkTypeSchema,
    showAsListening: z.boolean(),
    showPaused: z.boolean(),
    showServerImage: z.boolean(),
    showStateIcon: z.boolean(),
});

const FontSettingsSchema = z.object({
    builtIn: FontValueSchema,
    custom: z.string().nullable(),
    system: z.string().nullable(),
    type: z.nativeEnum(FontType),
});

const SkipButtonsSchema = z.object({
    enabled: z.boolean(),
    skipBackwardSeconds: z.number(),
    skipForwardSeconds: z.number(),
});

const PlayerbarSliderTypeSchema = z.enum(['slider', 'waveform']);

const BarAlignSchema = z.enum(['top', 'bottom', 'center']);

const PlayerbarSliderSchema = z.object({
    barAlign: BarAlignSchema,
    barGap: z.number(),
    barRadius: z.number(),
    barWidth: z.number(),
    loadingDelay: z.number(),
    stretched: z.boolean(),
    type: PlayerbarSliderTypeSchema,
});

const AudioMotionAnalyzerSettingsSchema = z.object({
    alphaBars: z
        .boolean()
        .describe(
            'When set to true each bar’s amplitude affects its opacity, i.e., higher bars are rendered more opaque while shorter bars are more transparent. This is similar to the lumiBars effect, but bars’ amplitudes are preserved and it also works on Discrete mode and radial spectrum.',
        ),
    ansiBands: z
        .boolean()
        .describe(
            'When set to true, ANSI/IEC preferred frequencies are used to generate the bands for octave bands modes (see mode). The preferred base-10 scale is used to compute the center and bandedge frequencies, as specified in the ANSI S1.11-2004 standard. When false, bands are based on the equal-tempered scale, so that in 1/12 octave bands the center of each band is perfectly tuned to a musical note.',
        ),
    barSpace: z
        .number()
        .describe(
            'Customize the spacing between bars in frequency bands modes (see mode). Use a value between 0 and 1 for spacing proportional to the band width. Values >= 1 will be considered as a literal number of pixels.',
        ),
    channelLayout: z
        .enum(['single', 'dual-combined', 'dual-horizontal', 'dual-vertical'])
        .describe('Defines the number and layout of analyzer channels.'),
    colorMode: z
        .enum(['gradient', 'bar-index', 'bar-level'])
        .describe('Selects the desired mode for coloring the analyzer bars.'),
    customGradients: z.array(
        z.object({
            colorStops: z.array(
                z.object({
                    color: z.string(),
                    level: z.number().min(0).max(1).optional(),
                    levelEnabled: z.boolean().optional(),
                    pos: z.number().min(0).max(1).optional(),
                    positionEnabled: z.boolean().optional(),
                }),
            ),
            dir: z.string().optional(),
            name: z.string(),
        }),
    ),
    fadePeaks: z
        .boolean()
        .describe(
            'When true, peaks fade out instead of falling down. It has no effect when peakLine is active.',
        ),
    fftSize: z
        .number()
        .describe(
            'Number of samples used for the FFT performed by the AnalyzerNode. It must be a power of 2 between 32 and 32768, so valid values are: 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, and 32768. Higher values provide more detail in the frequency domain, but less detail in the time domain (slower response), so you may need to adjust smoothing accordingly.',
        ),
    fillAlpha: z.number(),
    frequencyScale: z.enum(['bark', 'linear', 'log', 'mel']),
    gradient: z.string(),
    gradientLeft: z.string().optional(),
    gradientRight: z.string().optional(),
    gravity: z.number(),
    ledBars: z.boolean(),
    linearAmplitude: z.boolean(),
    linearBoost: z.number(),
    lineWidth: z.number(),
    loRes: z.boolean(),
    lumiBars: z.boolean(),
    maxDecibels: z.number(),
    maxFPS: z.number(),
    maxFreq: z.number(),
    minDecibels: z.number(),
    minFreq: z.number(),
    mirror: z.number(),
    mode: z.number(),
    noteLabels: z.boolean(),
    opacity: z.number().min(0).max(1),
    outlineBars: z.boolean(),
    peakFadeTime: z.number(),
    peakHoldTime: z.number(),
    peakLine: z.boolean(),
    presets: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            value: z.any(),
        }),
    ),
    radial: z.boolean(),
    radialInvert: z.boolean(),
    radius: z.number(),
    reflexAlpha: z.number(),
    reflexBright: z.number(),
    reflexFit: z.boolean(),
    reflexRatio: z.number(),
    roundBars: z.boolean(),
    showFPS: z.boolean(),
    showPeaks: z.boolean(),
    showScaleX: z.boolean(),
    showScaleY: z.boolean(),
    smoothing: z.number(),
    spinSpeed: z.number(),
    splitGradient: z.boolean(),
    trueLeds: z.boolean(),
    volume: z.number(),
    weightingFilter: z.enum(['', 'A', 'B', 'C', 'D', 'Z']),
});

const ButterchurnSettingsSchema = z.object({
    blendTime: z.number().min(0).max(10),
    currentPreset: z.string().optional(),
    cyclePresets: z.boolean(),
    cycleTime: z.number().min(1).max(300),
    ignoredPresets: z.array(z.string()),
    includeAllPresets: z.boolean(),
    maxFPS: z.number().min(0),
    opacity: z.number().min(0).max(1),
    randomizeNextPreset: z.boolean(),
    selectedPresets: z.array(z.string()),
});

const VisualizerSettingsSchema = z.object({
    audiomotionanalyzer: AudioMotionAnalyzerSettingsSchema,
    butterchurn: ButterchurnSettingsSchema,
    type: z.enum(['audiomotionanalyzer', 'butterchurn']),
});

export enum HomeFeatureStyle {
    MULTIPLE = 'multiple',
    SINGLE = 'single',
}

const AutoSaveSchema = z.object({
    count: z.number().min(0),
    enabled: z.boolean(),
});

export const GeneralSettingsSchema = z.object({
    accent: z
        .string()
        .refine(
            (val) => /^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/.test(val),
            {
                message: 'Accent must be a valid rgb() color string',
            },
        ),
    albumBackground: z.boolean(),
    albumBackgroundBlur: z.number(),
    albumFavoriteFilter: z.boolean().nullable(),
    artistBackground: z.boolean(),
    artistBackgroundBlur: z.number(),
    artistItems: z.array(SortableItemSchema(ArtistItemSchema)),
    artistPageSections: z.object({
        artistRadio: z.boolean(),
        discographyButtons: z.boolean(),
        externalLinks: z.boolean(),
        genres: z.boolean(),
    }),
    artistRadioCount: z.number(),
    artistReleaseTypeItems: z.array(SortableItemSchema(ArtistReleaseTypeItemSchema)),
    autoSave: AutoSaveSchema,
    blurExplicitImages: z.boolean(),
    buttonSize: z.number(),
    collapsedDetailSections: z.record(z.string(), z.boolean()),
    collections: z.array(CollectionSchema),
    combinedLyricsAndVisualizer: z.boolean(),
    disabledContextMenu: z.record(z.string(), z.boolean()),
    enableGridMultiSelect: z.boolean(),
    externalLinks: z.boolean(),
    followCurrentSong: z.boolean(),
    followSystemTheme: z.boolean(),
    // .default(true) so settings files from before these fields existed
    // safeParse cleanly (mirrors mobileShellForce). Defaults reproduce the
    // current hardcoded behavior — the feature components that consume these
    // ship in a later batch, so adding the fields changes nothing until a
    // user opts in.
    /** Show the genres section on album/artist detail pages. */
    genresDisplay: z.boolean().default(true),
    genreTarget: GenreTargetSchema,
    /**
     * Card corner-radius style for library grid cards. 'rounded-md' matches
     * the current hardcoded `--theme-radius-md` look.
     */
    gridCardCornerRadius: z
        .enum(['square', 'rounded-sm', 'rounded-md', 'rounded-lg', 'pill'])
        .default('rounded-md'),
    /**
     * Default card density for library grid cards. 'default' matches today's
     * standard sizing; per-list overrides still win when set.
     */
    gridCardSize: z.enum(['compact', 'default', 'large']).default('default'),
    /**
     * Default gap between library grid cards. 'sm' matches the current
     * per-list default; per-list overrides still win when set.
     */
    gridGap: z.enum(['lg', 'md', 'sm', 'xl', 'xs']).default('sm'),
    /**
     * Default metadata rows shown beneath grid cards. Empty array = keep the
     * existing per-item-type defaults (name + albumArtists for albums, etc.),
     * so the out-of-box behavior is unchanged.
     */
    gridMetadataRows: z
        .array(
            z.enum([
                'name',
                'albumArtists',
                'artists',
                'duration',
                'releaseYear',
                'releaseDate',
                'createdAt',
                'lastPlayedAt',
                'playCount',
                'genres',
                'album',
                'songCount',
                'albumCount',
                'rating',
                'userFavorite',
            ]),
        )
        .default([]),
    /**
     * Number of album/song items requested per page in regular home
     * carousels. 20 matches the current hardcoded itemLimit.
     */
    homeCarouselItemsPerPage: z.number().int().min(5).max(50).default(20),
    homeFeature: z.boolean(),
    /**
     * Auto-rotation interval (seconds) for home feature cards. 30 matches the
     * current hardcoded ROTATE_INTERVAL_MS (30_000 ms).
     */
    homeFeatureCardRotationIntervalSeconds: z.number().int().min(5).max(120).default(30),
    /**
     * Number of songs displayed in each home feature card. 10 matches the
     * current hardcoded SONGS_PER_CARD.
     */
    homeFeatureCardSongsPerCard: z.number().int().min(5).max(20).default(10),
    homeFeatureContent: z.enum([
        'album',
        'albumOfTheDay',
        'artist',
        'decade',
        'favorites',
        'forgottenFavorites',
        'genre',
        'recentlyPlayed',
        'surpriseMe',
        'timeMachine',
        'topPlayed',
        'unplayed',
    ]),
    homeFeatureStyle: z.nativeEnum(HomeFeatureStyle),
    homeFeelingLucky: z.boolean(),
    /** Show the time-aware greeting at the top of the home page. */
    homeGreetingVisible: z.boolean().default(true),
    homeItems: z.array(SortableItemSchema(HomeItemSchema)),
    imageRes: z.object({
        fullScreenPlayer: z.number(),
        header: z.number(),
        itemCard: z.number(),
        sidebar: z.number(),
        table: z.number(),
    }),
    language: z.string(),
    lastFM: z.boolean(),
    lastfmApiKey: z.string(),
    listenBrainz: z.boolean(),
    /*
     * Destination route for the mobile-shell "Library" bottom-tab. The bar
     * navigates here when the user taps Library; defaults to Albums (the
     * Spotify pattern). Values map to the corresponding /library/* routes;
     * 'playlists' jumps to the dedicated /playlists tree instead.
     *
     * .default('albums') so existing settings files from before this field
     * was added safeParse cleanly — without it, the strict schema would
     * reject the loaded state and the user would silently land on the
     * default-app defaults.
     */
    mobileLibraryDestination: z
        .enum(['albums', 'album-artists', 'artists', 'songs', 'genres', 'folders', 'playlists'])
        .default('albums'),
    /*
     * Show explicit prev/next buttons in the mobile mini-player. With
     * Motion-native horizontal swipe carrying the carousel commit, the
     * row works fine with just the play/pause button. Hidden by default
     * to give the song metadata more horizontal real estate; users who
     * still want the buttons can flip this on.
     */
    mobilePlayerbarShowNavButtons: z.boolean().default(false),
    /*
     * "Force mobile shell" override for users who want the touch-first
     * Spotify-style UI on larger displays (tablet in landscape, small
     * laptops). When true, useIsMobileShell() returns true regardless of
     * the actual viewport size, so the mobile layout is rendered.
     */
    mobileShellForce: z.boolean().default(false),
    musicBrainz: z.boolean(),
    nativeAspectRatio: z.boolean(),
    nativeSpotify: z.boolean(),
    passwordStore: z.string().optional(),
    pathReplace: z.string(),
    pathReplaceWith: z.string(),
    playButtonBehavior: z.nativeEnum(Play),
    playerbarOpenDrawer: z.boolean(),
    playerbarSlider: PlayerbarSliderSchema,
    playerItems: z.array(SortableItemSchema(PlayerItemSchema)),
    playlistTarget: PlaylistTargetSchema,
    prefetchSidebarAlbums: z.boolean(),
    prefetchUpcomingLyrics: z.boolean(),
    prefetchUpcomingLyricsCount: z.number().min(0).max(50),
    primaryShade: z.number().min(0).max(9),
    qobuz: z.boolean(),
    queueInPlaybackOrder: z.boolean(),
    resume: z.boolean(),
    showFilesystemNameForAlbums: z.boolean(),
    showFilesystemNameForFolders: z.boolean(),
    showLyricsInSidebar: z.boolean(),
    // .default(true) so a settings-file import from before this field was
    // added (or any future version-bump-less addition) doesn't fail
    // ValidationSettingsStateSchema.safeParse with a missing-key error.
    showPlaybarYearChip: z.boolean().default(true),
    /**
     * Show the user-rating star badge in the corner of grid-card images.
     * .default(true) reproduces the current always-on behavior.
     */
    showRatingBadge: z.boolean().default(true),
    showRatings: z.boolean(),
    showVisualizerInSidebar: z.boolean(),
    sidebarBottomSection: z.enum(['playlists', 'favoriteAlbums', 'none']),
    sidebarCollapsedNavigation: z.boolean(),
    sidebarCollapseShared: z.boolean(),
    sidebarItems: z.array(SidebarItemTypeSchema),
    sidebarPanelOrder: z.array(SidebarPanelTypeSchema),
    sidebarPlaylistFolders: z.boolean(),
    sidebarPlaylistFolderSeparator: z.string().min(1),
    sidebarPlaylistFolderTreeIndent: z.number().int().min(0).max(64),
    sidebarPlaylistFolderTreeLineColor: z.string(),
    sidebarPlaylistFolderView: SidebarPlaylistFolderViewSchema,
    sidebarPlaylistList: z.boolean(),
    sidebarPlaylistListFilterRegex: z.string(),
    sidebarPlaylistMode: SidebarPlaylistModeSchema,
    sidebarPlaylistSorting: z.boolean(),
    sideQueueLayout: SideQueueLayoutSchema,
    sideQueueType: SideQueueTypeSchema,
    skipButtons: SkipButtonsSchema,
    /** Show the external/social-links block on album/artist detail pages. */
    socialLinksDisplay: z.boolean().default(true),
    spotify: z.boolean(),
    theme: z.nativeEnum(AppTheme),
    themeDark: z.nativeEnum(AppTheme),
    themeLight: z.nativeEnum(AppTheme),
    trackmapBgGlowAlpha: z.number().min(0).max(100),
    trackmapBreathAmplitudePct: z.number().min(0).max(30),
    trackmapBreathPeriodSec: z.number().min(1).max(30),
    trackmapColorBgGlow: z.string(),
    trackmapColorCool: z.string(),
    trackmapColorStrandB: z.string(),
    trackmapColorWarm: z.string(),
    trackmapDimMaskMin: z.number().min(0).max(100),
    trackmapDimMaskTransitionPx: z.number().min(0).max(100),
    trackmapEnabled: z.boolean(),
    trackmapEnvelopeFillAlpha: z.number().min(0).max(100),
    trackmapEnvelopeOutlineAlpha: z.number().min(0).max(100),
    trackmapEnvelopeOutlineWidthPx: z.number().min(0).max(10),
    trackmapGlow: z.number().min(0).max(100),
    trackmapHaloBlurPx: z.number().min(0).max(50),
    trackmapHeight: z.number().min(0).max(100),
    trackmapHelixCycles: z.number().min(1).max(12),
    trackmapHelixRotationSec: z.number().min(0).max(120),
    trackmapOnlyOverLan: z.boolean(),
    trackmapPlayheadGlowAlpha: z.number().min(0).max(100),
    trackmapPlayheadShadowBlurPx: z.number().min(0).max(50),
    trackmapPlayheadWidthPx: z.number().min(1).max(20),
    trackmapRungAlpha: z.number().min(0).max(100),
    trackmapRungSpacingPx: z.number().min(4).max(100),
    trackmapSensitivity: z.number().min(0).max(100),
    trackmapStrandCrispAlpha: z.number().min(0).max(100),
    trackmapStrandHaloAlpha: z.number().min(0).max(100),
    trackmapStyle: TrackmapStyleSchema,
    useThemeAccentColor: z.boolean(),
    useThemePrimaryShade: z.boolean(),
    volumeWheelStep: z.number(),
    volumeWidth: z.number(),
    zoomFactor: z.number(),
});

const HotkeyBindingSchema = z.object({
    allowGlobal: z.boolean(),
    hotkey: z.string(),
    isGlobal: z.boolean(),
});

const HotkeysSettingsSchema = z.object({
    bindings: z
        .record(BindingActionsSchema, HotkeyBindingSchema)
        .refine((obj): obj is Required<typeof obj> =>
            BindingActionsSchema.options.every((key) => obj[key] != null),
        ),
    globalMediaHotkeys: z.boolean(),
});

const LyricsDisplaySettingsSchema = z.object({
    fontSize: z.number(),
    fontSizeUnsync: z.number(),
    gap: z.number(),
    gapUnsync: z.number(),
    opacityNonActive: z.number(),
    scaleNonActive: z.number(),
});

const LyricsSettingsSchema = z.object({
    alignment: z.enum(['center', 'left', 'right']),
    delayMs: z.number(),
    enableAutoTranslation: z.boolean(),
    enableNeteaseTranslation: z.boolean(),
    fetch: z.boolean(),
    follow: z.boolean(),
    preferLocalLyrics: z.boolean(),
    showMatch: z.boolean(),
    showProvider: z.boolean(),
    skipNeteasePlaceholders: z.boolean(),
    sources: z.array(z.nativeEnum(LyricSource)),
    translationApiKey: z.string(),
    translationApiProvider: z.string().nullable(),
    translationTargetLanguage: z.string().nullable(),
});

const ScrobbleSettingsSchema = z.object({
    enabled: z.boolean(),
    notify: z.boolean(),
    scrobbleAtDuration: z.number(),
    scrobbleAtPercentage: z.number(),
});

const PlayerFilterFieldSchema = z.enum([
    'name',
    'albumArtist',
    'artist',
    'duration',
    'genre',
    'year',
    'note',
    'path',
    'playCount',
    'favorite',
    'rating',
]);

const PlayerFilterOperatorSchema = z.enum([
    'is',
    'isNot',
    'contains',
    'notContains',
    'startsWith',
    'endsWith',
    'regex',
    'gt',
    'lt',
    'inTheRange',
    'before',
    'after',
    'beforeDate',
    'afterDate',
    'inTheRangeDate',
    'inTheLast',
    'notInTheLast',
]);

const PlayerFilterSchema = z.object({
    field: PlayerFilterFieldSchema,
    id: z.string(),
    isEnabled: z.boolean().optional(),
    operator: PlayerFilterOperatorSchema,
    value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string(), z.number()])),
    ]),
});

const PlaybackSettingsSchema = z.object({
    audioDeviceId: z.string().nullable().optional(),
    audioFadeOnStatusChange: z.boolean(),
    filters: z.array(PlayerFilterSchema),
    jellyfinRemoteControl: z.boolean(),
    mediaSession: z.boolean(),
    mpvAudioDeviceId: z.string().nullable().optional(),
    mpvExtraParameters: z.array(z.string()),
    mpvProperties: MpvSettingsSchema,
    preservePitch: z.boolean(),
    remoteTargetDeviceId: z.string().nullable().optional(),
    remoteTargetDeviceName: z.string().nullable().optional(),
    scrobble: ScrobbleSettingsSchema,
    /**
     * Number of seconds to fade the volume down before the sleep timer
     * pauses playback. 0 disables the fade (instant pause).
     */
    sleepTimerFadeSeconds: z.number().min(0).max(120),
    transcode: TranscodingConfigSchema,
    type: z.nativeEnum(PlayerType),
    webAudio: z.boolean(),
});

const RemoteSettingsSchema = z.object({
    enabled: z.boolean(),
    password: z.string(),
    port: z.number(),
    username: z.string(),
});

/**
 * Remote debug log shipping. When enabled, the renderer streams console
 * output, errors and a high-frequency heartbeat to `endpoint`
 * (`host[:port]`, plain HTTP) so crashes that kill the WebView — where
 * devtools and local logs die with the process — can be diagnosed from
 * another machine. Off by default; development tool, not a user feature.
 */
const RemoteDebugSettingsSchema = z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().default(''),
});

const WindowSettingsSchema = z.object({
    disableAutoUpdate: z.boolean(),
    exitToTray: z.boolean(),
    minimizeToTray: z.boolean(),
    preventSleepOnPlayback: z.boolean(),
    preventSuspendOnPlayback: z.boolean(),
    startMinimized: z.boolean(),
    tray: z.boolean(),
    windowBarStyle: z.nativeEnum(Platform),
});

const QueryValueInputTypeSchema = z.enum([
    'boolean',
    'date',
    'dateRange',
    'number',
    'playlist',
    'string',
]);

const QueryBuilderCustomFieldSchema = z.object({
    label: z.string(),
    type: QueryValueInputTypeSchema,
    value: z.string(),
});

const QueryBuilderSettingsSchema = z.object({
    tag: z.array(QueryBuilderCustomFieldSchema),
});

export const AUTO_DJ_MODE = {
    ALBUMS: 'albums',
    SONGS: 'songs',
} as const;

export type AutoDJMode = (typeof AUTO_DJ_MODE)[keyof typeof AUTO_DJ_MODE];

export const AUTO_DJ_STRATEGY = {
    LIBRARY_RANDOM: 'library_random',
    SIMILAR: 'similar',
} as const;

export type AutoDJStrategy = (typeof AUTO_DJ_STRATEGY)[keyof typeof AUTO_DJ_STRATEGY];

const autoDjStrategyEnum = z.enum(['similar', 'library_random']);

const AutoDJSettingsSchema = z.object({
    albumStrategy: autoDjStrategyEnum,
    enabled: z.boolean(),
    itemCount: z.number(),
    mode: z.enum(['songs', 'albums']),
    songStrategy: autoDjStrategyEnum,
    timing: z.number(),
});

/**
 * Local-first cache opt-in slice.
 *
 *  - `enabled` — three-state knob driving the first-launch opt-in flow.
 *    `undefined` means the user has never been asked (the modal opens on
 *    next launch when at least one server is configured). `true` activates
 *    the cache lifecycle, hydration banner, sync chip, and mutation
 *    worker. `false` keeps the subsystem inert.
 *  - `capacityBytes` — user-configurable storage cap on web / Android.
 *    `undefined` falls back to the platform default (see `eviction.ts`).
 */
// Per-entity sync toggles. Default ON for everything except thumbnails
// (controlled separately via `thumbnailSizes` below — empty = no thumbnail
// pre-cache, opt-in due to the size of the thumbnail blobs on disk).
const LocalCacheEntitiesSchema = z.object({
    albums: z.boolean().default(true),
    artists: z.boolean().default(true),
    favorites: z.boolean().default(true),
    genres: z.boolean().default(true),
    playlists: z.boolean().default(true),
    songs: z.boolean().default(true),
});

// Which `general.imageRes` buckets the thumbnail sweep pre-fetches. Empty
// = no pre-cache (lazy fetch via <BaseImage> remains in place; thumbnails
// still land in Dexie incidentally as the user browses).
const LocalCacheThumbnailSizeSchema = z.enum([
    'fullScreenPlayer',
    'header',
    'itemCard',
    'sidebar',
    'table',
]);

/**
 * Per-entity offline-media (audio download) config. Gated behind the
 * localCache opt-in — offline playback requires the metadata cache. Default
 * cap is 2 GiB; `downloadOriginal` true means we download the untranscoded
 * source file (smaller transcodes can be opted into later).
 */
const OfflineMediaSettingsSchema = z.object({
    downloadOriginal: z.boolean().default(true),
    maxBytes: z.number().default(2 * 1024 * 1024 * 1024),
});

/**
 * One surface bucket's variant config: whether the thumbnail sweep pre-caches
 * this resolution and the target longest-edge px (`0` = original / no resize).
 */
const LocalCacheImageVariantSchema = z.object({
    enabled: z.boolean(),
    px: z.number().int().min(0),
});

/**
 * Multi-resolution artwork variant cache config. `mode` is a global switch:
 *  - `downscale` (default) — fetch each cover once, canvas-resize + re-encode
 *    (`format`/`quality`) to every enabled variant.
 *  - `download` — request each enabled variant's px from the server directly;
 *    server bytes are stored as-is (`format`/`quality` are downscale-only).
 * `variants` keys mirror the existing surface buckets so the surface→variant
 * mapping needs no call-site plumbing.
 */
const LocalCacheImageVariantsSchema = z.object({
    format: z.enum(['webp', 'jpeg']).default('webp'),
    mode: z.enum(['download', 'downscale']).default('downscale'),
    quality: z.number().int().min(1).max(100).default(82),
    variants: z.object({
        fullScreen: LocalCacheImageVariantSchema,
        header: LocalCacheImageVariantSchema,
        itemCard: LocalCacheImageVariantSchema,
        sidebar: LocalCacheImageVariantSchema,
        table: LocalCacheImageVariantSchema,
    }),
});

const LocalCacheSettingsSchema = z.object({
    capacityBytes: z.number().optional(),
    enabled: z.boolean().optional(),
    entities: LocalCacheEntitiesSchema.optional(),
    imageVariants: LocalCacheImageVariantsSchema.optional(),
    offlineMedia: OfflineMediaSettingsSchema.optional(),
    sweepProgressSmoothing: z.boolean().default(true),
    // Worker count for the thumbnail pre-cache sweep. Higher = faster but
    // more concurrent fetches / IndexedDB writes. 24 is the default on
    // modern HTTP/2 servers. Range enforced at sweep start.
    thumbnailConcurrency: z.number().int().min(1).max(64).optional(),
    thumbnailSizes: z.array(LocalCacheThumbnailSizeSchema).optional(),
});

/**
 * Canonical default for `localCache.imageVariants`. Surface buckets mirror the
 * `general.imageRes` names. Shared by the initial state and the v55→56
 * migration so they can't drift.
 */
export const DEFAULT_IMAGE_VARIANTS: z.infer<typeof LocalCacheImageVariantsSchema> = {
    format: 'webp',
    mode: 'downscale',
    quality: 82,
    variants: {
        // Pre-caching full-resolution originals is OFF by default: a bulk sweep
        // of multi-megabyte originals takes hours. Originals load lazily on
        // demand; users who want them pre-cached can enable this.
        fullScreen: { enabled: false, px: 0 },
        header: { enabled: true, px: 300 },
        itemCard: { enabled: true, px: 300 },
        sidebar: { enabled: false, px: 400 },
        table: { enabled: true, px: 80 },
    },
};

/**
 * Peer-sync (MQTT) settings slice. Disabled by default; existing installs
 * behave identically to upstream until the user opts in from Settings →
 * Jellyfin Connect → Peer sync. The `broker` sub-object is desktop-only;
 * web and Android builds ignore it.
 */
const PeerSyncBrokerSettingsSchema = z.object({
    enabled: z.boolean().default(false),
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(8083),
    tlsCertPath: z.string().optional(),
    tlsKeyPath: z.string().optional(),
});

const PeerSyncUiVisibilitySchema = z.object({
    /** The "Connect to a device" button in the player bar. */
    connectButton: z.boolean().default(true),
    /** Filter the picker to only show devices whose MQTT presence we've
     *  received (i.e. another Feishin running peer-sync). Off = the picker
     *  also lists jellyfin-web, jellyfin-android-tv, and other clients
     *  reachable only via the Jellyfin Sessions API. The currently-selected
     *  target always remains visible so toggling on doesn't drop it.
     *  Default ON — only takes effect while the MQTT transport is
     *  configured (peerSync.enabled), so it is inert until then. */
    hideNonMqttDevices: z.boolean().default(true),
    /** Lane badge (MQTT / Jellyfin) next to each peer row in the picker. */
    pickerBadges: z.boolean().default(true),
    /** Compact transport pill near the player bar. */
    statusPill: z.boolean().default(true),
});

const PeerSyncSettingsSchema = z.object({
    /** Embedded broker settings (desktop only). */
    broker: PeerSyncBrokerSettingsSchema.default({
        enabled: false,
        host: '0.0.0.0',
        port: 8083,
    }),
    /** External broker password (when the broker requires auth). When set,
     *  overrides the default room-key-as-password used against the embedded
     *  broker. */
    brokerPassword: z.string().default(''),
    /** Optional broker URL. Empty = auto-discover via mDNS on desktop. */
    brokerUrl: z.string().default(''),
    /** External broker username (when the broker requires auth). When set,
     *  overrides the default Jellyfin-user-id-as-username used against the
     *  embedded broker. */
    brokerUsername: z.string().default(''),
    /** Master toggle for the MQTT peer-sync transport. Off = MQTT lane
     *  fully inert; Jellyfin Sessions polling continues per
     *  `jellyfinRemoteEnabled`. */
    enabled: z.boolean().default(false),
    /** Master toggle for Jellyfin Remote (device picker, controller,
     *  receiver, Sessions polling). Off = no remote-play UI or background
     *  polling whatsoever, regardless of `enabled`. Default true so
     *  upgrading users keep the existing behavior; the wizard flips it on
     *  explicitly. */
    jellyfinRemoteEnabled: z.boolean().default(true),
    /** True once the user has finished the Sync & Connect setup wizard.
     *  All Connect-related UI chrome is hidden until this flips true so
     *  fresh installs are uncluttered. */
    onboarded: z.boolean().default(false),
    /** Stable per-install peer id — auto-generated on first read. */
    peerId: z.string().default(''),
    /** Shared room key — auto-generated on first opt-in. */
    roomKey: z.string().default(''),
    /** MQTT transport selection. 'auto' (default) uses WebSocket on
     *  web/Electron and upgrades to raw TCP on Android when the broker URL
     *  carries an mqtt://(s) scheme; 'ws' forces WebSocket; 'tcp' forces raw
     *  TCP (Android only — falls back to WS when the native socket plugin is
     *  unavailable). Lets Android users reach brokers that expose only raw
     *  TCP on 1883/8883 and no WebSocket listener. */
    transport: z.enum(['auto', 'ws', 'tcp']).default('auto'),
    /** Per-element visibility toggles. Power users who don't want a
     *  particular Connect-related chrome can switch it off here. */
    ui: PeerSyncUiVisibilitySchema.default({
        connectButton: true,
        hideNonMqttDevices: true,
        pickerBadges: true,
        statusPill: true,
    }),
});

/**
 * This schema is used for validation of the imported settings json
 */
export const ValidationSettingsStateSchema = z.object({
    autoDJ: AutoDJSettingsSchema,
    css: CssSettingsSchema,
    discord: DiscordSettingsSchema,
    font: FontSettingsSchema,
    general: GeneralSettingsSchema,
    hotkeys: HotkeysSettingsSchema,
    lists: z.record(z.nativeEnum(ItemListKey), ItemListConfigSchema),
    localCache: LocalCacheSettingsSchema,
    lyrics: LyricsSettingsSchema,
    lyricsDisplay: z.record(z.string(), LyricsDisplaySettingsSchema),
    peerSync: PeerSyncSettingsSchema,
    playback: PlaybackSettingsSchema,
    queryBuilder: QueryBuilderSettingsSchema,
    remote: RemoteSettingsSchema,
    remoteDebug: RemoteDebugSettingsSchema,
    tab: z.union([
        z.literal('general'),
        z.literal('hotkeys'),
        z.literal('playback'),
        z.literal('window'),
        z.string(),
    ]),
    // Drill-down level inside the selected `tab`. Empty string = show
    // the subpages list for that category; non-empty = render that
    // subpage's content. Reset to '' when category changes.
    tabSubpage: z.string(),
    visualizer: VisualizerSettingsSchema,
    window: WindowSettingsSchema,
});

/**
 * This schema is merged below to create the full SettingsSchema but not used during import validation
 */
export const NonValidatedSettingsStateSchema = z.object({});

export const SettingsStateSchema = ValidationSettingsStateSchema.merge(
    NonValidatedSettingsStateSchema,
);

export enum ArtistItem {
    BIOGRAPHY = 'biography',
    FAVORITE_SONGS = 'favoriteSongs',
    RECENT_ALBUMS = 'recentAlbums',
    SIMILAR_ARTISTS = 'similarArtists',
    TOP_SONGS = 'topSongs',
}

export enum ArtistReleaseTypeItem {
    APPEARS_ON = 'appearsOn',
    RELEASE_TYPE_ALBUM = 'releaseTypeAlbum',
    RELEASE_TYPE_AUDIO_DRAMA = 'releaseTypeAudioDrama',
    RELEASE_TYPE_AUDIOBOOK = 'releaseTypeAudiobook',
    RELEASE_TYPE_BROADCAST = 'releaseTypeBroadcast',
    RELEASE_TYPE_COMPILATION = 'releaseTypeCompilation',
    RELEASE_TYPE_DEMO = 'releaseTypeDemo',
    RELEASE_TYPE_DJ_MIX = 'releaseTypeDjMix',
    RELEASE_TYPE_EP = 'releaseTypeEp',
    RELEASE_TYPE_FIELD_RECORDING = 'releaseTypeFieldRecording',
    RELEASE_TYPE_INTERVIEW = 'releaseTypeInterview',
    RELEASE_TYPE_LIVE = 'releaseTypeLive',
    RELEASE_TYPE_MIXTAPE_STREET = 'releaseTypeMixtapeStreet',
    RELEASE_TYPE_OTHER = 'releaseTypeOther',
    RELEASE_TYPE_REMIX = 'releaseTypeRemix',
    RELEASE_TYPE_SINGLE = 'releaseTypeSingle',
    RELEASE_TYPE_SOUNDTRACK = 'releaseTypeSoundtrack',
    RELEASE_TYPE_SPOKENWORD = 'releaseTypeSpokenWord',
}

export enum BarAlign {
    BOTTOM = 'bottom',
    CENTER = 'center',
    TOP = 'top',
}

export enum BindingActions {
    BROWSER_BACK = 'browserBack',
    BROWSER_FORWARD = 'browserForward',
    FAVORITE_CURRENT_ADD = 'favoriteCurrentAdd',
    FAVORITE_CURRENT_REMOVE = 'favoriteCurrentRemove',
    FAVORITE_CURRENT_TOGGLE = 'favoriteCurrentToggle',
    FAVORITE_PREVIOUS_ADD = 'favoritePreviousAdd',
    FAVORITE_PREVIOUS_REMOVE = 'favoritePreviousRemove',
    FAVORITE_PREVIOUS_TOGGLE = 'favoritePreviousToggle',
    GLOBAL_SEARCH = 'globalSearch',
    LIST_NAVIGATE_TO_PAGE = 'listNavigateToPage',
    LIST_PLAY_DEFAULT = 'listPlayDefault',
    LIST_PLAY_LAST = 'listPlayLast',
    LIST_PLAY_NEXT = 'listPlayNext',
    LIST_PLAY_NOW = 'listPlayNow',
    LIST_SHOW_PLAYING_SONG = 'listShowPlayingSong',
    LOCAL_SEARCH = 'localSearch',
    MUTE = 'volumeMute',
    NAVIGATE_HOME = 'navigateHome',
    NEXT = 'next',
    PAUSE = 'pause',
    PLAY = 'play',
    PLAY_PAUSE = 'playPause',
    PREVIOUS = 'previous',
    RATE_0 = 'rate0',
    RATE_1 = 'rate1',
    RATE_2 = 'rate2',
    RATE_3 = 'rate3',
    RATE_4 = 'rate4',
    RATE_5 = 'rate5',
    SHUFFLE = 'toggleShuffle',
    SKIP_BACKWARD = 'skipBackward',
    SKIP_FORWARD = 'skipForward',
    STOP = 'stop',
    TOGGLE_FULLSCREEN_PLAYER = 'toggleFullscreenPlayer',
    TOGGLE_QUEUE = 'toggleQueue',
    TOGGLE_REPEAT = 'toggleRepeat',
    VOLUME_DOWN = 'volumeDown',
    VOLUME_UP = 'volumeUp',
    ZOOM_IN = 'zoomIn',
    ZOOM_OUT = 'zoomOut',
}

export enum DiscordDisplayType {
    ARTIST_NAME = 'artist',
    FEISHIN = 'feishin',
    SONG_NAME = 'song',
}

export enum DiscordLinkType {
    LAST_FM = 'last_fm',
    MBZ = 'musicbrainz',
    MBZ_LAST_FM = 'musicbrainz_last_fm',
    NONE = 'none',
}

export enum GenreTarget {
    ALBUM = 'album',
    TRACK = 'track',
}

export enum HomeItem {
    GENRES = 'genres',
    LIBRARY_STATS = 'libraryStats',
    MOST_PLAYED = 'mostPlayed',
    NEW_SINCE_LAST_VISIT = 'newSinceLastVisit',
    QUICK_FILTERS = 'quickFilters',
    RANDOM = 'random',
    RECENTLY_ADDED = 'recentlyAdded',
    RECENTLY_PLAYED = 'recentlyPlayed',
    RECENTLY_RELEASED = 'recentlyReleased',
}

export enum PlayerbarSliderType {
    SLIDER = 'slider',
    WAVEFORM = 'waveform',
}

export enum PlayerItem {
    BIT_DEPTH = 'bit_depth',
    BIT_RATE = 'bit_rate',
    BPM = 'bpm',
    CODEC = 'codec',
    DISC_NUMBER = 'disc_number',
    GENRES = 'genres',
    RELEASE_DATE = 'release_date',
    RELEASE_TYPE = 'release_type',
    RELEASE_YEAR = 'release_year',
    SAMPLE_RATE = 'sample_rate',
    TRACK_NUMBER = 'track_number',
}

export enum PlaylistTarget {
    ALBUM = 'album',
    TRACK = 'track',
}

export enum SidebarItem {
    ALBUMS = 'Albums',
    ARTISTS = 'Artists',
    ARTISTS_ALL = 'Artists-all',
    COLLECTIONS = 'Collections',
    FAVORITES = 'Favorites',
    FOLDERS = 'Folders',
    GENRES = 'Genres',
    HOME = 'Home',
    NOW_PLAYING = 'Now Playing',
    PLAYLISTS = 'Playlists',
    RADIO = 'Radio',
    SEARCH = 'Search',
    SETTINGS = 'Settings',
    TRACKS = 'Tracks',
}

export type DataGridProps = {
    itemGap: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    itemsPerRow: number;
    itemsPerRowEnabled: boolean;
    rows: ItemGridListRowConfig[];
    size: 'compact' | 'default' | 'large';
};

export type DataTableProps = z.infer<typeof ItemTableListPropsSchema>;
export type ItemDetailListProps = z.infer<typeof ItemDetailListPropsSchema>;
export type ItemListSettings = {
    detail?: ItemDetailListProps;
    display: ListDisplayType;
    grid: DataGridProps;
    itemsPerPage: number;
    pagination: ListPaginationType;
    table: DataTableProps;
};

export type LocalCacheImageVariant = z.infer<typeof LocalCacheImageVariantSchema>;
export type LocalCacheImageVariants = z.infer<typeof LocalCacheImageVariantsSchema>;
export type LocalCacheSettings = z.infer<typeof LocalCacheSettingsSchema>;

export type OfflineMediaSettings = z.infer<typeof OfflineMediaSettingsSchema>;

export type PlayerFilter = z.infer<typeof PlayerFilterSchema>;

export type PlayerFilterField = z.infer<typeof PlayerFilterFieldSchema>;

export type PlayerFilterOperator = z.infer<typeof PlayerFilterOperatorSchema>;

export interface SettingsSlice extends z.infer<typeof SettingsStateSchema> {
    actions: {
        addCollection: (collection: SavedCollection) => void;
        removeCollection: (id: string) => void;
        reset: () => void;
        resetSampleRate: () => void;
        setArtistItems: (item: SortableItem<ArtistItem>[]) => void;
        setArtistReleaseTypeItems: (item: SortableItem<ArtistReleaseTypeItem>[]) => void;
        setGenreBehavior: (target: GenreTarget) => void;
        setHomeItems: (item: SortableItem<HomeItem>[]) => void;
        setList: (type: ItemListKey, data: DeepPartial<ItemListSettings>) => void;
        setLocalCache: (partial: Partial<LocalCacheSettings>) => void;
        setPlaybackFilters: (filters: PlayerFilter[]) => void;
        setPlayerItems: (items: SortableItem<PlayerItem>[]) => void;
        setPlaylistBehavior: (target: PlaylistTarget) => void;
        setSettings: (data: DeepPartial<SettingsState>) => void;
        setSidebarItems: (items: SidebarItemType[]) => void;
        setTable: (type: ItemListKey, data: DataTableProps) => void;
        setTranscodingConfig: (config: TranscodingConfig) => void;
        toggleMediaSession: () => void;
        toggleSidebarCollapseShare: () => void;
        updateCollection: (id: string, updates: Partial<Omit<SavedCollection, 'id'>>) => void;
    };
}
export interface SettingsState extends z.infer<typeof SettingsStateSchema> {}
export type SidebarItemType = z.infer<typeof SidebarItemTypeSchema>;

export type SideQueueLayout = z.infer<typeof SideQueueLayoutSchema>;
export type SideQueueType = z.infer<typeof SideQueueTypeSchema>;

export type SortableItem<T extends string> = {
    disabled: boolean;
    id: T;
};

export type TranscodingConfig = z.infer<typeof TranscodingConfigSchema>;

export type VersionedSettings = SettingsState & { version: number };

export const playerItems: SortableItem<PlayerItem>[] = [
    {
        disabled: true,
        id: PlayerItem.BIT_DEPTH,
    },
    {
        disabled: true,
        id: PlayerItem.BIT_RATE,
    },
    {
        disabled: true,
        id: PlayerItem.BPM,
    },
    {
        disabled: false,
        id: PlayerItem.CODEC,
    },
    {
        disabled: true,
        id: PlayerItem.DISC_NUMBER,
    },
    {
        disabled: true,
        id: PlayerItem.GENRES,
    },
    {
        disabled: true,
        id: PlayerItem.RELEASE_DATE,
    },
    {
        disabled: true,
        id: PlayerItem.RELEASE_TYPE,
    },
    {
        disabled: false,
        id: PlayerItem.RELEASE_YEAR,
    },
    {
        disabled: true,
        id: PlayerItem.SAMPLE_RATE,
    },
    {
        disabled: true,
        id: PlayerItem.TRACK_NUMBER,
    },
];

export const sidebarItems: SidebarItemType[] = [
    {
        disabled: true,
        id: 'Now Playing',
        label: i18n.t('page.sidebar.nowPlaying'),
        route: AppRoute.NOW_PLAYING,
    },
    {
        disabled: true,
        id: 'Search',
        label: i18n.t('page.sidebar.search'),
        route: generatePath(AppRoute.SEARCH, { itemType: LibraryItem.SONG }),
    },
    { disabled: false, id: 'Home', label: i18n.t('page.sidebar.home'), route: AppRoute.HOME },
    {
        disabled: false,
        id: 'Favorites',
        label: i18n.t('page.sidebar.favorites'),
        route: AppRoute.FAVORITES,
    },
    {
        disabled: false,
        id: 'Albums',
        label: i18n.t('page.sidebar.albums'),
        route: AppRoute.LIBRARY_ALBUMS,
    },
    {
        disabled: false,
        id: 'Tracks',
        label: i18n.t('page.sidebar.tracks'),
        route: AppRoute.LIBRARY_SONGS,
    },
    {
        disabled: false,
        id: 'Artists',
        label: i18n.t('page.sidebar.albumArtists'),
        route: AppRoute.LIBRARY_ALBUM_ARTISTS,
    },
    {
        disabled: false,
        id: 'Artists-all',
        label: i18n.t('page.sidebar.artists'),
        route: AppRoute.LIBRARY_ARTISTS,
    },
    {
        disabled: false,
        id: 'Genres',
        label: i18n.t('page.sidebar.genres'),
        route: AppRoute.LIBRARY_GENRES,
    },
    {
        disabled: false,
        id: 'Folders',
        label: i18n.t('page.sidebar.folders'),
        route: AppRoute.LIBRARY_FOLDERS,
    },
    {
        disabled: true,
        id: 'Playlists',
        label: i18n.t('page.sidebar.playlists'),
        route: AppRoute.PLAYLISTS,
    },
    {
        disabled: false,
        id: 'Collections',
        label: i18n.t('page.sidebar.collections'),
        route: '',
    },
    {
        disabled: false,
        id: 'Radio',
        label: i18n.t('page.sidebar.radio'),
        route: AppRoute.RADIO,
    },
    {
        disabled: true,
        id: 'Settings',
        label: i18n.t('page.sidebar.settings'),
        route: AppRoute.SETTINGS,
    },
];

const homeItems = Object.values(HomeItem).map((item) => ({
    disabled: false,
    id: item,
}));

/*
 * Default render order on the artist detail page. Top songs sits before
 * the recent-albums grid — what listeners want to see first when they
 * land on an artist is the music they're most likely to play. Albums and
 * everything else fall in below. Users can still re-order this in
 * Settings → Artist page.
 */
const artistItems = [
    ArtistItem.BIOGRAPHY,
    ArtistItem.TOP_SONGS,
    ArtistItem.RECENT_ALBUMS,
    ArtistItem.SIMILAR_ARTISTS,
    ArtistItem.FAVORITE_SONGS,
].map((item) => ({
    disabled: false,
    id: item,
}));

const artistReleaseTypeItems = Object.values(ArtistReleaseTypeItem).map((item) => ({
    disabled: false,
    id: item,
}));

// Determines the default/initial windowBarStyle value based on the current platform.
const getPlatformDefaultWindowBarStyle = (): Platform => {
    if (utils?.isWindows()) {
        return Platform.WINDOWS;
    }

    if (utils?.isMacOS()) {
        return Platform.MACOS;
    }

    if (utils?.isLinux()) {
        return Platform.WINDOWS;
    }

    return Platform.WEB;
};

const platformDefaultWindowBarStyle: Platform = getPlatformDefaultWindowBarStyle();

/**
 * Defaults for every advanced trackmap visual knob — the values reflect
 * what the user gets out of the box and what the "Reset advanced" button
 * in Settings → General → Trackmap snaps back to. The six primary knobs
 * (enabled / onlyOverLan / style / height / glow / sensitivity) are NOT
 * here because they sit above the Advanced toggle and are owned by the
 * user, not the design.
 */
export const TRACKMAP_ADVANCED_DEFAULTS = {
    trackmapBgGlowAlpha: 24,
    trackmapBreathAmplitudePct: 3,
    trackmapBreathPeriodSec: 7,
    trackmapColorBgGlow: '#7c3aed',
    trackmapColorCool: '#9b59f6',
    trackmapColorStrandB: '#f472b6',
    trackmapColorWarm: '',
    trackmapDimMaskMin: 55,
    trackmapDimMaskTransitionPx: 30,
    trackmapEnvelopeFillAlpha: 55,
    trackmapEnvelopeOutlineAlpha: 90,
    trackmapEnvelopeOutlineWidthPx: 1,
    trackmapHaloBlurPx: 14,
    trackmapHelixCycles: 6,
    trackmapHelixRotationSec: 0,
    trackmapPlayheadGlowAlpha: 60,
    trackmapPlayheadShadowBlurPx: 12,
    trackmapPlayheadWidthPx: 3,
    trackmapRungAlpha: 35,
    trackmapRungSpacingPx: 22,
    trackmapStrandCrispAlpha: 90,
    trackmapStrandHaloAlpha: 65,
} as const;

const initialState: SettingsState = {
    autoDJ: {
        albumStrategy: AUTO_DJ_STRATEGY.SIMILAR,
        enabled: false,
        itemCount: 5,
        mode: 'songs',
        songStrategy: AUTO_DJ_STRATEGY.SIMILAR,
        timing: 1,
    },
    css: {
        content: '',
        enabled: false,
    },
    discord: {
        clientId: '1165957668758900787',
        displayType: DiscordDisplayType.FEISHIN,
        enabled: false,
        linkType: DiscordLinkType.NONE,
        showAsListening: false,
        showPaused: true,
        showServerImage: false,
        showStateIcon: true,
    },
    font: {
        builtIn: 'Inter',
        custom: null,
        system: null,
        type: FontType.BUILT_IN,
    },
    general: {
        accent: 'rgb(53, 116, 252)',
        albumBackground: false,
        albumBackgroundBlur: 3,
        albumFavoriteFilter: null,
        artistBackground: true,
        artistBackgroundBlur: 3,
        artistItems,
        artistPageSections: {
            artistRadio: false,
            discographyButtons: false,
            externalLinks: false,
            genres: false,
        },
        artistRadioCount: 20,
        artistReleaseTypeItems,
        autoSave: {
            count: 10,
            enabled: false,
        },
        blurExplicitImages: false,
        buttonSize: 15,
        collapsedDetailSections: {},
        collections: [],
        combinedLyricsAndVisualizer: true,
        disabledContextMenu: {},
        enableGridMultiSelect: false,
        externalLinks: true,
        followCurrentSong: true,
        followSystemTheme: false,
        genresDisplay: true,
        genreTarget: GenreTarget.TRACK,
        gridCardCornerRadius: 'rounded-md',
        gridCardSize: 'default',
        gridGap: 'sm',
        gridMetadataRows: [],
        homeCarouselItemsPerPage: 20,
        homeFeature: true,
        homeFeatureCardRotationIntervalSeconds: 30,
        homeFeatureCardSongsPerCard: 10,
        homeFeatureContent: 'artist',
        homeFeatureStyle: HomeFeatureStyle.SINGLE,
        homeFeelingLucky: true,
        homeGreetingVisible: true,
        homeItems,
        imageRes: {
            fullScreenPlayer: 0,
            header: 300,
            itemCard: 300,
            sidebar: 400,
            table: 80,
        },
        language: 'en',
        lastFM: true,
        lastfmApiKey: '',
        listenBrainz: true,
        mobileLibraryDestination: 'albums',
        mobilePlayerbarShowNavButtons: false,
        mobileShellForce: false,
        musicBrainz: true,
        nativeAspectRatio: false,
        nativeSpotify: false,
        passwordStore: undefined,
        pathReplace: '',
        pathReplaceWith: '',
        playButtonBehavior: Play.NOW,
        playerbarOpenDrawer: false,
        playerbarSlider: {
            barAlign: BarAlign.CENTER,
            barGap: 1,
            barRadius: 4,
            barWidth: 2,
            loadingDelay: 2,
            stretched: false,
            type: PlayerbarSliderType.SLIDER,
        },
        playerItems,
        playlistTarget: PlaylistTarget.TRACK,
        prefetchSidebarAlbums: true,
        prefetchUpcomingLyrics: true,
        prefetchUpcomingLyricsCount: 8,
        primaryShade: 6,
        qobuz: true,
        queueInPlaybackOrder: true,
        resume: true,
        showFilesystemNameForAlbums: false,
        showFilesystemNameForFolders: true,
        showLyricsInSidebar: true,
        showPlaybarYearChip: true,
        showRatingBadge: true,
        showRatings: true,
        showVisualizerInSidebar: true,
        sidebarBottomSection: 'playlists',
        sidebarCollapsedNavigation: true,
        sidebarCollapseShared: false,
        sidebarItems,
        sidebarPanelOrder: ['queue', 'lyrics', 'visualizer'],
        sidebarPlaylistFolders: true,
        sidebarPlaylistFolderSeparator: '/',
        sidebarPlaylistFolderTreeIndent: 16,
        sidebarPlaylistFolderTreeLineColor: '',
        sidebarPlaylistFolderView: 'tree',
        sidebarPlaylistList: true,
        sidebarPlaylistListFilterRegex: '',
        sidebarPlaylistMode: 'expanded',
        sidebarPlaylistSorting: false,
        sideQueueLayout: 'horizontal',
        sideQueueType: 'sideQueue',
        skipButtons: {
            enabled: false,
            skipBackwardSeconds: 5,
            skipForwardSeconds: 10,
        },
        socialLinksDisplay: true,
        spotify: true,
        theme: AppTheme.SPOTIFY,
        themeDark: AppTheme.SPOTIFY,
        themeLight: AppTheme.DEFAULT_LIGHT,
        ...TRACKMAP_ADVANCED_DEFAULTS,
        trackmapEnabled: true,
        trackmapGlow: 70,
        trackmapHeight: 60,
        trackmapOnlyOverLan: false,
        trackmapSensitivity: 50,
        trackmapStyle: 'glow',
        useThemeAccentColor: false,
        useThemePrimaryShade: true,
        volumeWheelStep: 5,
        volumeWidth: 70,
        zoomFactor: 100,
    },
    hotkeys: {
        bindings: {
            browserBack: { allowGlobal: false, hotkey: '', isGlobal: false },
            browserForward: { allowGlobal: false, hotkey: '', isGlobal: false },
            favoriteCurrentAdd: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoriteCurrentRemove: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoriteCurrentToggle: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoritePreviousAdd: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoritePreviousRemove: { allowGlobal: true, hotkey: '', isGlobal: false },
            favoritePreviousToggle: { allowGlobal: true, hotkey: '', isGlobal: false },
            globalSearch: { allowGlobal: false, hotkey: 'mod+k', isGlobal: false },
            listNavigateToPage: { allowGlobal: false, hotkey: 'mod+g', isGlobal: false },
            listPlayDefault: { allowGlobal: false, hotkey: 'enter', isGlobal: false },
            listPlayLast: { allowGlobal: false, hotkey: '', isGlobal: false },
            listPlayNext: { allowGlobal: false, hotkey: '', isGlobal: false },
            listPlayNow: { allowGlobal: false, hotkey: '', isGlobal: false },
            listShowPlayingSong: { allowGlobal: false, hotkey: 'mod+l', isGlobal: false },
            localSearch: { allowGlobal: false, hotkey: 'mod+f', isGlobal: false },
            navigateHome: { allowGlobal: false, hotkey: 'mod+h', isGlobal: false },
            // Most defaults below were empty strings — new users had a
            // non-functional keyboard out of the box. Ship sensible defaults
            // borrowed from Spotify / Apple Music conventions so the app
            // feels usable without going to Settings first. Users can still
            // remap or clear any binding.
            next: { allowGlobal: true, hotkey: 'mod+right', isGlobal: false },
            pause: { allowGlobal: true, hotkey: '', isGlobal: false },
            play: { allowGlobal: true, hotkey: '', isGlobal: false },
            playPause: { allowGlobal: true, hotkey: 'space', isGlobal: false },
            previous: { allowGlobal: true, hotkey: 'mod+left', isGlobal: false },
            rate0: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate1: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate2: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate3: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate4: { allowGlobal: true, hotkey: '', isGlobal: false },
            rate5: { allowGlobal: true, hotkey: '', isGlobal: false },
            skipBackward: { allowGlobal: true, hotkey: 'left', isGlobal: false },
            skipForward: { allowGlobal: true, hotkey: 'right', isGlobal: false },
            stop: { allowGlobal: true, hotkey: '', isGlobal: false },
            toggleFullscreenPlayer: { allowGlobal: false, hotkey: 'f', isGlobal: false },
            toggleQueue: { allowGlobal: false, hotkey: 'q', isGlobal: false },
            toggleRepeat: { allowGlobal: true, hotkey: 'r', isGlobal: false },
            toggleShuffle: { allowGlobal: true, hotkey: 's', isGlobal: false },
            volumeDown: { allowGlobal: true, hotkey: 'down', isGlobal: false },
            volumeMute: { allowGlobal: true, hotkey: 'm', isGlobal: false },
            volumeUp: { allowGlobal: true, hotkey: 'up', isGlobal: false },
            zoomIn: { allowGlobal: true, hotkey: '', isGlobal: false },
            zoomOut: { allowGlobal: true, hotkey: '', isGlobal: false },
        },
        globalMediaHotkeys: true,
    },
    lists: {
        ['albumDetail']: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [],
                    columns: SONG_TABLE_COLUMNS,
                    columnWidths: {
                        [TableColumn.DURATION]: 100,
                        [TableColumn.IMAGE]: 50,
                        [TableColumn.TITLE]: 400,
                        [TableColumn.USER_FAVORITE]: 60,
                    },
                    enabledColumns: [
                        TableColumn.IMAGE,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
        },
        fullScreen: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [ItemListKey.PLAYLIST_ALBUM]: {
            detail: {
                columns: pickTableColumns({
                    autoSizeColumns: [],
                    columns: SONG_TABLE_COLUMNS,
                    columnWidths: {
                        [TableColumn.ACTIONS]: 60,
                        [TableColumn.DURATION]: 100,
                        [TableColumn.TITLE]: 400,
                        [TableColumn.TRACK_NUMBER]: 50,
                        [TableColumn.USER_FAVORITE]: 60,
                    },
                    enabledColumns: [
                        TableColumn.TRACK_NUMBER,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                        TableColumn.ACTIONS,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.YEAR,
                    ],
                    columns: ALBUM_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE, TableColumn.ALBUM_ARTIST, TableColumn.YEAR],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.SONG_COUNT,
                        TableColumn.RELEASE_DATE,
                        TableColumn.LAST_PLAYED,
                        TableColumn.YEAR,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: ALBUM_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.ALBUM]: {
            detail: {
                columns: pickTableColumns({
                    autoSizeColumns: [],
                    columns: SONG_TABLE_COLUMNS,
                    columnWidths: {
                        [TableColumn.ACTIONS]: 60,
                        [TableColumn.DURATION]: 100,
                        [TableColumn.TITLE]: 400,
                        [TableColumn.TRACK_NUMBER]: 50,
                        [TableColumn.USER_FAVORITE]: 60,
                    },
                    enabledColumns: [
                        TableColumn.TRACK_NUMBER,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                        TableColumn.ACTIONS,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.YEAR,
                    ],
                    columns: ALBUM_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE, TableColumn.ALBUM_ARTIST, TableColumn.YEAR],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.ALBUM_ARTIST,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.SONG_COUNT,
                        TableColumn.RELEASE_DATE,
                        TableColumn.LAST_PLAYED,
                        TableColumn.YEAR,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: ALBUM_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.ALBUM_ARTIST]: {
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.IMAGE,
                        TableColumn.TITLE,
                        TableColumn.USER_FAVORITE,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.ARTIST]: {
            display: ListDisplayType.GRID,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.PLAY_COUNT,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE],
                    columns: ALBUM_ARTIST_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.IMAGE,
                        TableColumn.TITLE,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                        TableColumn.PLAY_COUNT,
                        TableColumn.LAST_PLAYED,
                        TableColumn.USER_FAVORITE,
                        TableColumn.USER_RATING,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.GENRE]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [
                        TableColumn.TITLE,
                        TableColumn.SONG_COUNT,
                        TableColumn.ALBUM_COUNT,
                    ],
                    columns: GENRE_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.TITLE,
                        TableColumn.SONG_COUNT,
                        TableColumn.ALBUM_COUNT,
                    ],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.ALBUM_COUNT,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: false,
                columns: GENRE_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'compact',
            },
        },
        [LibraryItem.PLAYLIST]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE, TableColumn.SONG_COUNT],
                    columns: PLAYLIST_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE],
                    pickColumns: [TableColumn.TITLE, TableColumn.SONG_COUNT],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE],
                    columns: PLAYLIST_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.TITLE,
                        TableColumn.DURATION,
                        TableColumn.SONG_COUNT,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.PLAYLIST_SONG]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    columns: PLAYLIST_SONG_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.ARTIST,
                        TableColumn.DURATION,
                        TableColumn.YEAR,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.CODEC,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.LAST_PLAYED,
                        TableColumn.RELEASE_DATE,
                        TableColumn.TRACK_NUMBER,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: PLAYLIST_SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.QUEUE_SONG]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        [LibraryItem.SONG]: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: pickGridRows({
                    alignLeftColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    columns: SONG_TABLE_COLUMNS,
                    enabledColumns: [TableColumn.TITLE, TableColumn.ARTIST],
                    pickColumns: [
                        TableColumn.TITLE,
                        TableColumn.ARTIST,
                        TableColumn.DURATION,
                        TableColumn.YEAR,
                        TableColumn.BIT_RATE,
                        TableColumn.BPM,
                        TableColumn.CODEC,
                        TableColumn.DATE_ADDED,
                        TableColumn.GENRE,
                        TableColumn.LAST_PLAYED,
                        TableColumn.RELEASE_DATE,
                        TableColumn.TRACK_NUMBER,
                    ],
                }),
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.PAGINATED,
            table: {
                autoFitColumns: true,
                columns: SONG_TABLE_COLUMNS.map((column) => ({
                    align: column.align,
                    autoSize: column.autoSize,
                    id: column.value,
                    isEnabled: column.isEnabled,
                    pinned: column.pinned,
                    width: column.width,
                })),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
        ['sideQueue']: {
            display: ListDisplayType.TABLE,
            grid: {
                itemGap: 'sm',
                itemsPerRow: 6,
                itemsPerRowEnabled: false,
                rows: [],
                size: 'default',
            },
            itemsPerPage: 50,
            pagination: ListPaginationType.INFINITE,
            table: {
                autoFitColumns: true,
                columns: pickTableColumns({
                    autoSizeColumns: [TableColumn.TITLE_COMBINED],
                    columns: SONG_TABLE_COLUMNS,
                    enabledColumns: [
                        TableColumn.ROW_INDEX,
                        TableColumn.TITLE_COMBINED,
                        TableColumn.DURATION,
                        TableColumn.USER_FAVORITE,
                    ],
                }),
                enableAlternateRowColors: false,
                enableHeader: true,
                enableHorizontalBorders: false,
                enableRowHoverHighlight: true,
                enableVerticalBorders: false,
                size: 'default',
            },
        },
    },
    localCache: {
        capacityBytes: undefined,
        enabled: undefined,
        entities: {
            albums: true,
            artists: true,
            favorites: true,
            genres: true,
            playlists: true,
            songs: true,
        },
        imageVariants: DEFAULT_IMAGE_VARIANTS,
        offlineMedia: {
            downloadOriginal: true,
            maxBytes: 2 * 1024 * 1024 * 1024,
        },
        sweepProgressSmoothing: true,
        thumbnailSizes: [],
    },
    lyrics: {
        alignment: 'center',
        delayMs: 0,
        enableAutoTranslation: false,
        enableNeteaseTranslation: false,
        fetch: true,
        follow: true,
        preferLocalLyrics: true,
        showMatch: true,
        showProvider: true,
        skipNeteasePlaceholders: true,
        sources: [LyricSource.NETEASE, LyricSource.LRCLIB],
        translationApiKey: '',
        translationApiProvider: '',
        translationTargetLanguage: 'en',
    },
    lyricsDisplay: {
        default: {
            fontSize: 24,
            fontSizeUnsync: 24,
            gap: 24,
            gapUnsync: 24,
            opacityNonActive: 0.2,
            scaleNonActive: 0.95,
        },
    },
    peerSync: {
        broker: {
            enabled: false,
            host: '0.0.0.0',
            port: 8083,
            tlsCertPath: undefined,
            tlsKeyPath: undefined,
        },
        brokerPassword: '',
        brokerUrl: '',
        brokerUsername: '',
        enabled: false,
        jellyfinRemoteEnabled: true,
        onboarded: false,
        peerId: '',
        roomKey: '',
        transport: 'auto',
        ui: {
            connectButton: true,
            hideNonMqttDevices: true,
            pickerBadges: true,
            statusPill: true,
        },
    },
    playback: {
        audioDeviceId: undefined,
        audioFadeOnStatusChange: true,
        filters: [],
        jellyfinRemoteControl: true,
        mediaSession: false,
        mpvAudioDeviceId: undefined,
        mpvExtraParameters: [],
        mpvProperties: {
            audioExclusiveMode: 'no',
            audioFormat: undefined,
            audioSampleRateHz: 0,
            gaplessAudio: 'weak',
            replayGainClip: true,
            // Default fallback gain for tracks with NO ReplayGain tags. Without
            // this, untagged songs play at raw file loudness while tagged songs
            // are normalized — the common library-wide consistency gap. -6 dB
            // roughly matches the loudness of a typical RG-tagged library
            // (RG reference is ~89 dB / -18 LUFS), so untagged tracks aren't
            // noticeably louder than their tagged neighbours.
            replayGainFallbackDB: -6,
            replayGainMode: 'track',
            replayGainPreampDB: 0,
        },
        preservePitch: true,
        remoteTargetDeviceId: null,
        remoteTargetDeviceName: null,
        scrobble: {
            enabled: true,
            notify: false,
            scrobbleAtDuration: 240,
            scrobbleAtPercentage: 75,
        },
        sleepTimerFadeSeconds: 8,
        transcode: {
            enabled: false,
        },
        type: PlayerType.WEB,
        webAudio: true,
    },
    queryBuilder: {
        tag: [],
    },
    remote: {
        enabled: false,
        password: randomString(8),
        port: 4333,
        username: 'feishin',
    },
    remoteDebug: {
        enabled: false,
        endpoint: '',
    },
    tab: 'general',
    tabSubpage: '',
    visualizer: {
        audiomotionanalyzer: {
            alphaBars: false,
            ansiBands: false,
            barSpace: 0.7,
            channelLayout: 'single',
            colorMode: 'gradient',
            customGradients: [],
            fadePeaks: true,
            fftSize: 16384,
            fillAlpha: 0,
            frequencyScale: 'log',
            gradient: 'rainbow',
            gravity: 15,
            ledBars: false,
            linearAmplitude: false,
            linearBoost: 3.1,
            lineWidth: 1.9,
            loRes: false,
            lumiBars: false,
            maxDecibels: -15,
            maxFPS: 144,
            maxFreq: 22050,
            minDecibels: -85,
            minFreq: 20,
            mirror: 0,
            mode: 10,
            noteLabels: false,
            opacity: 1,
            outlineBars: false,
            peakFadeTime: 2000,
            peakHoldTime: 388,
            peakLine: true,
            presets: audiomotionanalyzerPresets,
            radial: true,
            radialInvert: false,
            radius: 0.75,
            reflexAlpha: 0.1,
            reflexBright: 1,
            reflexFit: true,
            reflexRatio: 0.6,
            roundBars: false,
            showFPS: false,
            showPeaks: true,
            showScaleX: false,
            showScaleY: false,
            smoothing: 0.6,
            spinSpeed: 1.3,
            splitGradient: false,
            trueLeds: false,
            volume: 1,
            weightingFilter: '',
        },
        butterchurn: {
            blendTime: 2.5,
            currentPreset: '_Geiss - untitled',
            cyclePresets: false,
            cycleTime: 30,
            ignoredPresets: [],
            includeAllPresets: true,
            maxFPS: 0,
            opacity: 1,
            randomizeNextPreset: true,
            selectedPresets: [],
        },
        type: 'butterchurn',
    },
    window: {
        disableAutoUpdate: false,
        exitToTray: false,
        minimizeToTray: false,
        preventSleepOnPlayback: false,
        preventSuspendOnPlayback: false,
        startMinimized: false,
        tray: true,
        windowBarStyle: platformDefaultWindowBarStyle,
    },
};

const initialStateWithEnv = mergeWith(
    cloneDeep(initialState),
    getEnvSettingsOverrides(),
) as SettingsState;

export const useSettingsStore = createWithEqualityFn<SettingsSlice>()(
    persist(
        devtools(
            subscribeWithSelector(
                immer((set) => ({
                    actions: {
                        addCollection: (collection: SavedCollection) => {
                            set((state) => {
                                state.general.collections.push(collection);
                            });
                        },
                        removeCollection: (id: string) => {
                            set((state) => {
                                state.general.collections = state.general.collections.filter(
                                    (c) => c.id !== id,
                                );
                            });
                        },
                        reset: () => {
                            localStorage.removeItem('store_settings');
                            window.location.reload();
                        },
                        resetSampleRate: () => {
                            set((state) => {
                                state.playback.mpvProperties.audioSampleRateHz = 0;
                            });
                        },
                        setArtistItems: (items) => {
                            set((state) => {
                                state.general.artistItems = items;
                            });
                        },
                        setArtistReleaseTypeItems: (
                            items: SortableItem<ArtistReleaseTypeItem>[],
                        ) => {
                            set((state) => {
                                state.general.artistReleaseTypeItems = items;
                            });
                        },
                        setGenreBehavior: (target: GenreTarget) => {
                            set((state) => {
                                state.general.genreTarget = target;
                            });
                        },
                        setHomeItems: (items: SortableItem<HomeItem>[]) => {
                            set((state) => {
                                state.general.homeItems = items;
                            });
                        },
                        setList: (type: ItemListKey, data: DeepPartial<ItemListSettings>) => {
                            set((state) => {
                                const listState = state.lists[type];

                                if (listState && data.table) {
                                    Object.assign(listState.table, data.table);
                                    delete data.table;
                                }

                                if (listState && data.detail) {
                                    if (!listState.detail) {
                                        const t = listState.table;
                                        listState.detail = {
                                            columns: t.columns,
                                            enableAlternateRowColors: false,
                                            enableHeader: t.enableHeader,
                                            enableHorizontalBorders: t.enableHorizontalBorders,
                                            enableRowHoverHighlight: t.enableRowHoverHighlight,
                                            enableVerticalBorders: t.enableVerticalBorders,
                                            size: t.size,
                                        };
                                    }
                                    Object.assign(listState.detail, data.detail);
                                    delete data.detail;
                                }

                                if (listState && data.grid) {
                                    Object.assign(listState.grid, data.grid);
                                    delete data.grid;
                                }

                                if (listState) {
                                    Object.assign(listState, data);
                                }
                            });
                        },
                        setLocalCache: (partial) => {
                            set((state) => {
                                state.localCache = { ...state.localCache, ...partial };
                            });
                        },
                        setPlaybackFilters: (filters: PlayerFilter[]) => {
                            set((state) => {
                                state.playback.filters = filters;
                            });
                        },
                        setPlayerItems: (items: SortableItem<PlayerItem>[]) => {
                            set((state) => {
                                state.general.playerItems = items;
                            });
                        },
                        setPlaylistBehavior: (target: PlaylistTarget) => {
                            set((state) => {
                                state.general.playlistTarget = target;
                            });
                        },
                        setSettings: (data) => {
                            set((state) => {
                                deepMergeIntoState(state, data);
                            });
                        },
                        setSidebarItems: (items: SidebarItemType[]) => {
                            set((state) => {
                                state.general.sidebarItems = items;
                            });
                        },
                        setTable: (type: ItemListKey, data: DataTableProps) => {
                            set((state) => {
                                const listState = state.lists[type];
                                if (listState) {
                                    listState.table = data;
                                }
                            });
                        },
                        setTranscodingConfig: (config) => {
                            set((state) => {
                                state.playback.transcode = config;
                            });
                        },
                        toggleMediaSession: () => {
                            set((state) => {
                                state.playback.mediaSession = !state.playback.mediaSession;
                            });
                        },
                        toggleSidebarCollapseShare: () => {
                            set((state) => {
                                state.general.sidebarCollapseShared =
                                    !state.general.sidebarCollapseShared;
                            });
                        },
                        updateCollection: (
                            id: string,
                            updates: Partial<Omit<SavedCollection, 'id'>>,
                        ) => {
                            set((state) => {
                                const idx = state.general.collections.findIndex((c) => c.id === id);
                                if (idx !== -1) {
                                    Object.assign(state.general.collections[idx], updates);
                                }
                            });
                        },
                    },
                    ...initialStateWithEnv,
                })),
            ),
            { name: 'store_settings' },
        ),
        {
            merge: mergeOverridingColumns,
            migrate(persistedState, version) {
                const state = persistedState as SettingsSlice;

                if (version === 8) {
                    state.general.sidebarItems = state.general.sidebarItems.filter(
                        (item) => item.id !== 'Folders',
                    );
                    state.general.sidebarItems.push({
                        disabled: false,
                        id: 'Artists-all',
                        label: i18n.t('page.sidebar.artists'),
                        route: AppRoute.LIBRARY_ARTISTS,
                    });
                }

                if (version <= 9) {
                    if (!state.playback.mediaSession) {
                        state.playback.mediaSession = initialState.playback.mediaSession;
                    }

                    if (!state.general.artistBackgroundBlur) {
                        state.general.artistBackgroundBlur =
                            initialState.general.artistBackgroundBlur;
                    }

                    if (!state.general.artistBackground) {
                        state.general.artistBackground = initialState.general.artistBackground;
                    }

                    state.window.windowBarStyle = Platform.LINUX;

                    return state;
                }

                if (version <= 10) {
                    state.general.sidebarItems.push({
                        disabled: false,
                        id: 'Favorites',
                        label: i18n.t('page.sidebar.favorites'),
                        route: AppRoute.FAVORITES,
                    });
                }

                if (version <= 11) {
                    return {};
                }

                if (version <= 12) {
                    state.general.sidebarItems.push({
                        disabled: false,
                        id: 'Folders',
                        label: i18n.t('page.sidebar.folders'),
                        route: AppRoute.LIBRARY_FOLDERS,
                    });
                }

                if (version <= 13) {
                    state.general.homeItems.push({
                        disabled: false,
                        id: HomeItem.GENRES,
                    });
                }

                if (version <= 14) {
                    // Add bitDepth and sampleRate columns to song lists

                    const bitDepthColumn: ItemTableListColumnConfig = {
                        align: 'center',
                        autoSize: false,
                        id: TableColumn.BIT_DEPTH,
                        isEnabled: false,
                        pinned: null,
                        width: 100,
                    };

                    const sampleRateColumn: ItemTableListColumnConfig = {
                        align: 'center',
                        autoSize: false,
                        id: TableColumn.SAMPLE_RATE,
                        isEnabled: false,
                        pinned: null,
                        width: 100,
                    };

                    const columns = [bitDepthColumn, sampleRateColumn];

                    state.lists[LibraryItem.SONG]?.table.columns.push(...columns);
                    state.lists[LibraryItem.PLAYLIST_SONG]?.table.columns.push(...columns);
                    state.lists[LibraryItem.QUEUE_SONG]?.table.columns.push(...columns);
                    state.lists['albumDetail']?.table.columns.push(...columns);
                    state.lists['fullScreen']?.table.columns.push(...columns);
                    state.lists['sideQueue']?.table.columns.push(...columns);
                }

                if (version <= 15) {
                    state.general.sidebarItems.push({
                        disabled: false,
                        id: 'Radio',
                        label: i18n.t('page.sidebar.radio'),
                        route: AppRoute.RADIO,
                    });
                }

                if (version <= 17) {
                    // Migrate lyrics settings from record structure to separate lyrics and lyricsDisplay
                    if (
                        state.lyrics &&
                        typeof state.lyrics === 'object' &&
                        'default' in state.lyrics
                    ) {
                        const oldLyrics = state.lyrics as any;
                        const defaultSettings = oldLyrics.default || oldLyrics;

                        // Extract display settings
                        const displaySettings = {
                            fontSize: defaultSettings.fontSize || 24,
                            fontSizeUnsync: defaultSettings.fontSizeUnsync || 24,
                            gap: defaultSettings.gap || 24,
                            gapUnsync: defaultSettings.gapUnsync || 24,
                        };

                        // Remove display properties from main settings
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        const { fontSize, fontSizeUnsync, gap, gapUnsync, ...mainSettings } =
                            defaultSettings;

                        state.lyrics = mainSettings;
                        state.lyricsDisplay = {
                            default: {
                                ...(state.lyricsDisplay?.default || {}),
                                ...displaySettings,
                            },
                        };
                    }
                }

                if (version <= 18) {
                    // Add isEnabled property to all existing player filters
                    if (state.playback?.filters && Array.isArray(state.playback.filters)) {
                        state.playback.filters = state.playback.filters.map((filter) => ({
                            ...filter,
                            isEnabled: true,
                        }));
                    }
                }

                if (version <= 19) {
                    // Add IDs to presets that don't have them
                    if (
                        state.visualizer?.audiomotionanalyzer?.presets &&
                        Array.isArray(state.visualizer.audiomotionanalyzer.presets)
                    ) {
                        state.visualizer.audiomotionanalyzer.presets =
                            state.visualizer.audiomotionanalyzer.presets.map((preset) => {
                                if (!preset.id) {
                                    return {
                                        ...preset,
                                        id: nanoid(),
                                    };
                                }
                                return preset;
                            });
                    }
                }

                if (version <= 20) {
                    // Add TITLE_ARTIST column to SONG and ALBUM table configs
                    const titleArtistColumn: ItemTableListColumnConfig = {
                        align: 'start',
                        autoSize: false,
                        id: TableColumn.TITLE_ARTIST,
                        isEnabled: false,
                        pinned: null,
                        width: 300,
                    };

                    const listKeysToUpdate: (LibraryItem | string)[] = [
                        LibraryItem.SONG,
                        LibraryItem.ALBUM,
                        LibraryItem.PLAYLIST_SONG,
                        LibraryItem.QUEUE_SONG,
                        ItemListKey.ALBUM_DETAIL,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasTitleArtist = columns.some(
                                (col) => col.id === TableColumn.TITLE_ARTIST,
                            );
                            if (!hasTitleArtist) {
                                const titleCombinedIndex = columns.findIndex(
                                    (col) => col.id === TableColumn.TITLE_COMBINED,
                                );
                                if (titleCombinedIndex >= 0) {
                                    columns.splice(titleCombinedIndex + 1, 0, titleArtistColumn);
                                } else {
                                    columns.push(titleArtistColumn);
                                }
                            }
                        }
                    });
                }

                if (version <= 21) {
                    // Add COMPOSER column to SONG and ALBUM table configs
                    const composerColumn: ItemTableListColumnConfig = {
                        align: 'start',
                        autoSize: false,
                        id: TableColumn.COMPOSER,
                        isEnabled: false,
                        pinned: null,
                        width: 300,
                    };

                    const listKeysToUpdate: (LibraryItem | string)[] = [
                        LibraryItem.SONG,
                        LibraryItem.ALBUM,
                        LibraryItem.PLAYLIST_SONG,
                        LibraryItem.QUEUE_SONG,
                        ItemListKey.ALBUM_DETAIL,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasComposer = columns.some(
                                (col) => col.id === TableColumn.COMPOSER,
                            );
                            if (!hasComposer) {
                                const artistIndex = columns.findIndex(
                                    (col) => col.id === TableColumn.ARTIST,
                                );
                                if (artistIndex >= 0) {
                                    columns.splice(artistIndex + 1, 0, composerColumn);
                                } else {
                                    columns.push(composerColumn);
                                }
                            }
                        }
                    });
                }

                if (version <= 22) {
                    // Add enableHeader to all list table configs
                    Object.keys(state.lists).forEach((listKey) => {
                        const listConfig = state.lists[listKey as keyof typeof state.lists];
                        if (
                            listConfig?.table &&
                            typeof listConfig.table === 'object' &&
                            !('enableHeader' in listConfig.table)
                        ) {
                            (listConfig.table as any).enableHeader = true;
                        }
                    });
                }

                if (version <= 23) {
                    // Add FAVORITE_SONGS to album artist page configuration
                    const hasFavoriteSongs = state.general.artistItems?.some(
                        (item) => item.id === ArtistItem.FAVORITE_SONGS,
                    );

                    if (!hasFavoriteSongs && state.general.artistItems) {
                        state.general.artistItems.push({
                            disabled: false,
                            id: ArtistItem.FAVORITE_SONGS,
                        });
                    }
                }

                if (version <= 26) {
                    // Add ALBUM_GROUP column to the song table config
                    const listKeysToUpdate: ItemListKey[] = [
                        ItemListKey.SONG,
                        ItemListKey.FOLDER,
                        ItemListKey.PLAYLIST_SONG,
                        ItemListKey.ALBUM_ARTIST_SONG,
                        ItemListKey.GENRE_SONG,
                        ItemListKey.QUEUE_SONG,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey as keyof typeof state.lists];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasAlbumGroup = columns.some(
                                (col) => col.id === TableColumn.ALBUM_GROUP,
                            );
                            if (!hasAlbumGroup) {
                                columns.push({
                                    align: 'start',
                                    autoSize: false,
                                    id: TableColumn.ALBUM_GROUP,
                                    isEnabled: false,
                                    pinned: 'left',
                                    width: 200,
                                });
                            }
                        }
                    });
                }

                if (version <= 27) {
                    if (!state.general.sideQueueLayout) {
                        state.general.sideQueueLayout = initialState.general.sideQueueLayout;
                    }
                }

                if (version <= 28) {
                    if (state.playback.jellyfinRemoteControl === undefined) {
                        state.playback.jellyfinRemoteControl =
                            initialState.playback.jellyfinRemoteControl;
                    }
                }

                if (version <= 29) {
                    if (state.general.queueInPlaybackOrder === undefined) {
                        state.general.queueInPlaybackOrder =
                            initialState.general.queueInPlaybackOrder;
                    }
                }

                if (version <= 30) {
                    if (state.lyrics.skipNeteasePlaceholders === undefined) {
                        state.lyrics.skipNeteasePlaceholders =
                            initialState.lyrics.skipNeteasePlaceholders;
                    }
                }

                if (version <= 31) {
                    // Add FOLDER_NAME column option to existing song-style tables.
                    // Users won't see it enabled by default but it'll be available
                    // in the column picker.
                    const listKeysToUpdate: ItemListKey[] = [
                        ItemListKey.SONG,
                        ItemListKey.FOLDER,
                        ItemListKey.PLAYLIST_SONG,
                        ItemListKey.ALBUM_ARTIST_SONG,
                        ItemListKey.GENRE_SONG,
                        ItemListKey.QUEUE_SONG,
                        ItemListKey.FULL_SCREEN,
                        ItemListKey.SIDE_QUEUE,
                    ];

                    listKeysToUpdate.forEach((listKey) => {
                        const listConfig = state.lists[listKey as keyof typeof state.lists];
                        if (listConfig?.table?.columns) {
                            const columns = listConfig.table.columns;
                            const hasFolderName = columns.some(
                                (col) => col.id === TableColumn.FOLDER_NAME,
                            );
                            if (!hasFolderName) {
                                columns.push({
                                    align: 'start',
                                    autoSize: false,
                                    id: TableColumn.FOLDER_NAME,
                                    isEnabled: false,
                                    pinned: null,
                                    width: 200,
                                });
                            }
                        }
                    });
                }

                if (version <= 32) {
                    if (state.general.showFilesystemNameForFolders === undefined) {
                        state.general.showFilesystemNameForFolders =
                            initialState.general.showFilesystemNameForFolders;
                    }
                    if (state.general.showFilesystemNameForAlbums === undefined) {
                        state.general.showFilesystemNameForAlbums =
                            initialState.general.showFilesystemNameForAlbums;
                    }
                    // Default audio normalization to 'track' for existing users
                    // who never customized it (i.e. were on the previous default 'no').
                    if (state.playback.mpvProperties?.replayGainMode === 'no') {
                        state.playback.mpvProperties.replayGainMode = 'track';
                    }
                }

                if (version <= 33) {
                    // Replace Track # with Image as the leading column for the
                    // album detail song table. Jellyfin libraries that lack
                    // track-number tags would otherwise leave a column rendering
                    // an endless skeleton.
                    const albumDetailColumns =
                        state.lists?.[ItemListKey.ALBUM_DETAIL]?.table?.columns;
                    if (Array.isArray(albumDetailColumns)) {
                        const existingTrackIdx = albumDetailColumns.findIndex(
                            (c) => c.id === TableColumn.TRACK_NUMBER,
                        );
                        if (existingTrackIdx !== -1) {
                            albumDetailColumns[existingTrackIdx].isEnabled = false;
                        }
                        const existingImageIdx = albumDetailColumns.findIndex(
                            (c) => c.id === TableColumn.IMAGE,
                        );
                        const imageColumn =
                            existingImageIdx !== -1
                                ? {
                                      ...albumDetailColumns[existingImageIdx],
                                      isEnabled: true,
                                      width: 50,
                                  }
                                : {
                                      align: 'center' as const,
                                      autoSize: false,
                                      id: TableColumn.IMAGE,
                                      isEnabled: true,
                                      pinned: null,
                                      width: 50,
                                  };
                        if (existingImageIdx !== -1) {
                            albumDetailColumns.splice(existingImageIdx, 1);
                        }
                        albumDetailColumns.unshift(imageColumn);
                    }
                }

                if (version <= 34) {
                    // Convert the legacy boolean toggle for the playlist sidebar
                    // section into the new enum that lets users pick what the
                    // bottom section shows. Existing users who had it disabled
                    // get 'none' so the section stays hidden.
                    if (state.general.sidebarBottomSection === undefined) {
                        state.general.sidebarBottomSection =
                            state.general.sidebarPlaylistList === false ? 'none' : 'playlists';
                    }
                }

                if (version <= 35) {
                    if (state.general.homeFeelingLucky === undefined) {
                        state.general.homeFeelingLucky = initialState.general.homeFeelingLucky;
                    }
                }

                if (version <= 36) {
                    // Existing installs default to the new featured-artist card,
                    // matching new-install behaviour. Users who prefer the old
                    // random-album banner can switch back in Settings.
                    if (state.general.homeFeatureContent === undefined) {
                        state.general.homeFeatureContent = initialState.general.homeFeatureContent;
                    }
                }

                if (version <= 37) {
                    // Add the new LIBRARY_STATS home item to existing
                    // users' configurations. Defaults to disabled so the
                    // widget doesn't displace anything until the user
                    // opts in from Settings → General → Home.
                    if (Array.isArray(state.general.homeItems)) {
                        const hasStats = state.general.homeItems.some(
                            (i: { id: string }) => i.id === HomeItem.LIBRARY_STATS,
                        );
                        if (!hasStats) {
                            state.general.homeItems = [
                                ...state.general.homeItems,
                                { disabled: true, id: HomeItem.LIBRARY_STATS },
                            ];
                        }
                    }
                }

                if (version <= 38) {
                    if (state.playback.sleepTimerFadeSeconds === undefined) {
                        state.playback.sleepTimerFadeSeconds =
                            initialState.playback.sleepTimerFadeSeconds;
                    }
                }

                if (version <= 39) {
                    // Add the new QUICK_FILTERS home item to existing
                    // installs. Default disabled — users can enable it
                    // alongside other home items in Settings.
                    if (Array.isArray(state.general.homeItems)) {
                        const hasChips = state.general.homeItems.some(
                            (i: { id: string }) => i.id === HomeItem.QUICK_FILTERS,
                        );
                        if (!hasChips) {
                            state.general.homeItems = [
                                ...state.general.homeItems,
                                { disabled: true, id: HomeItem.QUICK_FILTERS },
                            ];
                        }
                    }
                }

                if (version <= 40) {
                    // Add NEW_SINCE_LAST_VISIT. Enabled by default because
                    // it's a friendly noisy-only-when-relevant widget — the
                    // banner self-hides when no new albums exist.
                    if (Array.isArray(state.general.homeItems)) {
                        const has = state.general.homeItems.some(
                            (i: { id: string }) => i.id === HomeItem.NEW_SINCE_LAST_VISIT,
                        );
                        if (!has) {
                            state.general.homeItems = [
                                { disabled: false, id: HomeItem.NEW_SINCE_LAST_VISIT },
                                ...state.general.homeItems,
                            ];
                        }
                    }
                }

                if (version <= 41) {
                    // Jellyfin Connect: persist the last-picked remote
                    // playback target across launches so the user lands
                    // back on the device they were controlling.
                    if (state.playback.remoteTargetDeviceId === undefined) {
                        state.playback.remoteTargetDeviceId =
                            initialState.playback.remoteTargetDeviceId;
                    }
                    if (state.playback.remoteTargetDeviceName === undefined) {
                        state.playback.remoteTargetDeviceName =
                            initialState.playback.remoteTargetDeviceName;
                    }
                }

                if (version <= 42) {
                    // Trackmap feature — six new keys under state.general.
                    if (state.general.trackmapEnabled === undefined) {
                        state.general.trackmapEnabled = initialState.general.trackmapEnabled;
                    }
                    if (state.general.trackmapGlow === undefined) {
                        state.general.trackmapGlow = initialState.general.trackmapGlow;
                    }
                    if (state.general.trackmapHeight === undefined) {
                        state.general.trackmapHeight = initialState.general.trackmapHeight;
                    }
                    if (state.general.trackmapOnlyOverLan === undefined) {
                        state.general.trackmapOnlyOverLan =
                            initialState.general.trackmapOnlyOverLan;
                    }
                    if (state.general.trackmapSensitivity === undefined) {
                        state.general.trackmapSensitivity =
                            initialState.general.trackmapSensitivity;
                    }
                    if (state.general.trackmapStyle === undefined) {
                        state.general.trackmapStyle = initialState.general.trackmapStyle;
                    }
                }

                if (version <= 43) {
                    // Trackmap advanced knobs — populate any missing field
                    // from the matching TRACKMAP_ADVANCED_DEFAULTS entry so
                    // upgraders get the current visual out of the box. The
                    // same constant powers the "Reset advanced" button.
                    for (const k of Object.keys(TRACKMAP_ADVANCED_DEFAULTS) as Array<
                        keyof typeof TRACKMAP_ADVANCED_DEFAULTS
                    >) {
                        if (state.general[k] === undefined) {
                            // The cast is safe because every advanced key has
                            // a matching default of the same type.
                            (state.general as any)[k] = TRACKMAP_ADVANCED_DEFAULTS[k];
                        }
                    }
                }

                if (version <= 44) {
                    // Seed the new localCache slice for users upgrading from
                    // a build that predates the opt-in modal. `enabled` left
                    // undefined so the modal opens on next launch; capacity
                    // left undefined so eviction falls back to the platform
                    // default until the user picks a cap.
                    if (!state.localCache || typeof state.localCache !== 'object') {
                        state.localCache = {
                            capacityBytes: undefined,
                            enabled: undefined,
                            sweepProgressSmoothing: true,
                        };
                    }
                }

                if (version <= 45) {
                    // Backfill per-entity toggles and thumbnail-size picker
                    // for users upgrading from the first cache release. All
                    // entities default ON so existing cache contents stay
                    // populated. `thumbnailSizes` left empty so the user
                    // explicitly opts in to thumbnail pre-cache (large blob
                    // store).
                    if (state.localCache) {
                        if (!state.localCache.entities) {
                            state.localCache.entities = {
                                albums: true,
                                artists: true,
                                favorites: true,
                                genres: true,
                                playlists: true,
                                songs: true,
                            };
                        }
                        if (!Array.isArray(state.localCache.thumbnailSizes)) {
                            state.localCache.thumbnailSizes = [];
                        }
                    }
                }

                if (version <= 46) {
                    // Seed the new peerSync slice for existing installs.
                    // Disabled by default so behavior is identical to the
                    // previous release until the user opts in. peerId and
                    // roomKey are lazily generated on first toggle-on by
                    // the settings UI, so we leave them empty here.
                    if (!state.peerSync || typeof state.peerSync !== 'object') {
                        state.peerSync = initialState.peerSync;
                    }
                }

                if (version <= 47) {
                    // Add the brokerUsername / brokerPassword fields for
                    // external brokers that require auth. Empty strings
                    // preserve the existing embedded-broker behavior
                    // (userId-as-username, roomKey-as-password).
                    if (state.peerSync && typeof state.peerSync === 'object') {
                        if (typeof state.peerSync.brokerUsername !== 'string') {
                            state.peerSync.brokerUsername = '';
                        }
                        if (typeof state.peerSync.brokerPassword !== 'string') {
                            state.peerSync.brokerPassword = '';
                        }
                    }
                }

                if (version <= 48) {
                    // Hide Connect-related UI chrome until the user has
                    // finished the new Sync & Connect setup wizard, and
                    // expose per-element visibility toggles. Existing
                    // installs are NOT treated as "onboarded" because the
                    // wizard introduces choices the previous UI didn't
                    // surface (broker tier, etc.).
                    if (state.peerSync && typeof state.peerSync === 'object') {
                        if (typeof state.peerSync.onboarded !== 'boolean') {
                            state.peerSync.onboarded = false;
                        }
                        if (!state.peerSync.ui || typeof state.peerSync.ui !== 'object') {
                            state.peerSync.ui = {
                                connectButton: true,
                                hideNonMqttDevices: false,
                                pickerBadges: true,
                                statusPill: true,
                            };
                        } else if (typeof state.peerSync.ui.hideNonMqttDevices !== 'boolean') {
                            // v48 -> v49 upgraders already have a `ui` block
                            // but it was created before this field existed;
                            // backfill the default so the picker filter
                            // doesn't read undefined and silently treat it
                            // as "hide everything".
                            state.peerSync.ui.hideNonMqttDevices = false;
                        }
                    }
                }

                if (version <= 49) {
                    // Add the Jellyfin Remote master kill-switch. Default
                    // true on upgrade so the picker + Sessions polling
                    // continue to work; users who want a quiet install can
                    // flip it off explicitly.
                    if (state.peerSync && typeof state.peerSync === 'object') {
                        if (typeof state.peerSync.jellyfinRemoteEnabled !== 'boolean') {
                            state.peerSync.jellyfinRemoteEnabled = true;
                        }
                    }
                }

                if (version <= 50) {
                    // Seed the new offline-media (per-entity audio download)
                    // config under the existing localCache slice. The feature
                    // is gated behind localCache.enabled, so this is inert
                    // until the user has opted into the metadata cache. 2 GiB
                    // default cap; original (untranscoded) downloads.
                    if (state.localCache && typeof state.localCache === 'object') {
                        if (
                            !state.localCache.offlineMedia ||
                            typeof state.localCache.offlineMedia !== 'object'
                        ) {
                            state.localCache.offlineMedia = {
                                downloadOriginal: true,
                                maxBytes: 2 * 1024 * 1024 * 1024,
                            };
                        }
                    }
                }

                if (version <= 51) {
                    // Add the MQTT transport selector. 'auto' preserves the
                    // existing WebSocket behaviour everywhere except Android
                    // with an mqtt://(s) broker URL, so upgraders see no change
                    // until they opt into raw TCP.
                    if (state.peerSync && typeof state.peerSync === 'object') {
                        const t = (state.peerSync as { transport?: unknown }).transport;
                        if (t !== 'auto' && t !== 'ws' && t !== 'tcp') {
                            (state.peerSync as { transport: string }).transport = 'auto';
                        }
                    }
                }

                if (version <= 52) {
                    // The room key (== broker auth password) is no longer a
                    // user-editable random value: it is derived deterministically
                    // from the Jellyfin username at connect time so a user's own
                    // devices authenticate to each other's broker. Clear any stale
                    // random key left over from the old editor so the diagnostics
                    // display doesn't show a value the live client never uses. The
                    // field is kept (vestigial) for backwards-compatible shape.
                    if (state.peerSync && typeof state.peerSync === 'object') {
                        (state.peerSync as { roomKey?: unknown }).roomKey = '';
                    }
                }

                if (version <= 53) {
                    // Seed a default ReplayGain fallback gain for existing users
                    // who never set one (it was previously `undefined`). Untagged
                    // tracks were playing at raw file loudness while tagged tracks
                    // were normalized, breaking library-wide loudness consistency.
                    // -6 dB roughly matches a typical RG-tagged library. Only
                    // applied when normalization is on, so users with RG disabled
                    // see no change.
                    const mpv = state.playback?.mpvProperties;
                    if (
                        mpv &&
                        typeof mpv === 'object' &&
                        mpv.replayGainMode !== 'no' &&
                        (mpv.replayGainFallbackDB === undefined ||
                            mpv.replayGainFallbackDB === null ||
                            Number.isNaN(mpv.replayGainFallbackDB))
                    ) {
                        mpv.replayGainFallbackDB =
                            initialState.playback.mpvProperties.replayGainFallbackDB;
                    }
                }

                if (version <= 54) {
                    // Release channels (alpha/beta/latest) were removed: the fork
                    // is a single rolling release. Drop the obsolete persisted key.
                    delete (state.window as { releaseChannel?: unknown }).releaseChannel;
                }

                if (version <= 55) {
                    // Seed the new multi-resolution artwork variant config under
                    // the existing localCache slice. Inert until the thumbnail
                    // sweep / resolver read it; gated behind localCache.enabled
                    // like the rest of the cache. Mirrors DEFAULT_IMAGE_VARIANTS
                    // so the upgrade default can't drift from the initial state.
                    if (state.localCache && typeof state.localCache === 'object') {
                        if (
                            !state.localCache.imageVariants ||
                            typeof state.localCache.imageVariants !== 'object'
                        ) {
                            state.localCache.imageVariants = DEFAULT_IMAGE_VARIANTS;
                        }
                    }
                }

                if (version <= 56) {
                    // The first artwork-variant build shipped with fullScreen
                    // (full-resolution original) pre-caching ENABLED by default,
                    // which made the thumbnail sweep download multi-megabyte
                    // originals per item (hours-long syncs). Flip it off for
                    // anyone still on that exact default; users who want it can
                    // re-enable it, and a custom px (an intentional change) is
                    // left untouched.
                    const iv = state.localCache?.imageVariants;
                    if (
                        iv?.variants?.fullScreen?.enabled === true &&
                        iv.variants.fullScreen.px === 0
                    ) {
                        iv.variants.fullScreen.enabled = false;
                    }
                }

                if (version <= 57) {
                    // Seed the remote-debug log shipper slice (disabled).
                    if (!state.remoteDebug || typeof state.remoteDebug !== 'object') {
                        state.remoteDebug = initialState.remoteDebug;
                    }
                }

                if (version <= 58) {
                    // Introduce per-section toggles for the artist detail page.
                    // Default everything to hidden so existing users opt-in explicitly.
                    // `state.general` is guarded: sparse blobs (tests / partial
                    // imports) may not carry the slice, and a throwing migrate
                    // makes zustand discard the WHOLE persisted state.
                    if (state.general && !state.general.artistPageSections) {
                        state.general.artistPageSections = {
                            ...initialState.general.artistPageSections,
                        };
                    }
                }

                if (version <= 59) {
                    // 'Hide devices without MQTT' becomes the default. It only
                    // takes effect while peer-sync is configured (the picker
                    // gates the filter on peerSync.enabled), so flipping it on
                    // is inert for Jellyfin-only installs.
                    if (state.peerSync?.ui) {
                        state.peerSync.ui.hideNonMqttDevices = true;
                    }
                }

                return persistedState;
            },
            name: 'store_settings',
            version: 60,
        },
    ),
);

export const useSettingsStoreActions = () => useSettingsStore((state) => state.actions);

export const usePlaybackSettings = () => useSettingsStore((state) => state.playback, shallow);

export const useRemoteTargetSetting = () =>
    useSettingsStore(
        (state) => ({
            deviceId: state.playback.remoteTargetDeviceId ?? null,
            deviceName: state.playback.remoteTargetDeviceName ?? null,
        }),
        shallow,
    );

export const useTableSettings = (type: ItemListKey) =>
    useSettingsStore((state) => state.lists[type as keyof typeof state.lists]);

export const useGeneralSettings = () => useSettingsStore((state) => state.general, shallow);

export const usePlaybackType = () => useSettingsStore((state) => state.playback.type, shallow);

export const usePlayButtonBehavior = () =>
    useSettingsStore((state) => state.general.playButtonBehavior, shallow);

export const useWindowSettings = () => useSettingsStore((state) => state.window, shallow);

export const useWindowBarStyle = () =>
    useSettingsStore((state) => state.window.windowBarStyle, shallow);

export const useHotkeySettings = () => useSettingsStore((state) => state.hotkeys, shallow);

export const useHotkeyBindings = () => useSettingsStore((state) => state.hotkeys.bindings, shallow);

export const useLayoutHotkeyBindings = () =>
    useSettingsStore(
        (state) => ({
            browserBack: state.hotkeys.bindings.browserBack,
            browserForward: state.hotkeys.bindings.browserForward,
            globalSearch: state.hotkeys.bindings.globalSearch,
            navigateHome: state.hotkeys.bindings.navigateHome,
            zoomIn: state.hotkeys.bindings.zoomIn,
            zoomOut: state.hotkeys.bindings.zoomOut,
        }),
        shallow,
    );

export const useMpvSettings = () =>
    useSettingsStore((state) => state.playback.mpvProperties, shallow);

export const useLyricsSettings = () => useSettingsStore((state) => state.lyrics, shallow);

export const useLyricsDisplaySettings = (key: string = 'default') =>
    useSettingsStore((state) => state.lyricsDisplay[key] || state.lyricsDisplay.default, shallow);

export const useRemoteSettings = () => useSettingsStore((state) => state.remote, shallow);

export const usePeerSyncSettings = () => useSettingsStore((state) => state.peerSync, shallow);

export const useRemoteDebugSettings = () => useSettingsStore((state) => state.remoteDebug, shallow);

export const useImageVariants = () =>
    useSettingsStore((state) => state.localCache.imageVariants, shallow);

export const useFontSettings = () => useSettingsStore((state) => state.font, shallow);

export const useDiscordSettings = () => useSettingsStore((state) => state.discord, shallow);

export const useCssSettings = () => useSettingsStore((state) => state.css, shallow);

export const useQueryBuilderSettings = () =>
    useSettingsStore((state) => state.queryBuilder, shallow);

const getSettingsStoreVersion = () => useSettingsStore.persist.getOptions().version!;

export const useSettingsForExport = (): SettingsState & { version: number } =>
    useSettingsStore((state) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- actions needs to be omitted from the export as it contains store functions
        const { actions, ...otherSettings } = state;
        return {
            ...otherSettings,
            version: getSettingsStoreVersion(),
        };
    });

export const migrateSettings = (settings: SettingsState, settingsVersion: number): SettingsState =>
    useSettingsStore.persist.getOptions().migrate!(settings, settingsVersion) as SettingsState;

export const useListSettings = (type: ItemListKey) =>
    useSettingsStore(
        (state) => state.lists[type as keyof typeof state.lists],
        shallow,
    ) as ItemListSettings;

export const usePrimaryColor = () => useSettingsStore((store) => store.general.accent, shallow);

export const usePlayerbarSlider = () =>
    useSettingsStore((store) => store.general.playerbarSlider, shallow);

export const useGenreTarget = () => useSettingsStore((store) => store.general.genreTarget, shallow);

export const usePlaylistTarget = () =>
    useSettingsStore((store) => store.general.playlistTarget, shallow);

export const useLanguage = () => useSettingsStore((state) => state.general.language, shallow);

export const useAccent = () => useSettingsStore((state) => state.general.accent, shallow);

export const useNativeAspectRatio = () =>
    useSettingsStore((state) => state.general.nativeAspectRatio, shallow);

export const useButtonSize = () => useSettingsStore((state) => state.general.buttonSize, shallow);

export const useSkipButtons = () => useSettingsStore((state) => state.general.skipButtons, shallow);

export const useImageRes = () => useSettingsStore((state) => state.general.imageRes, shallow);

export const useVolumeWidth = () => useSettingsStore((state) => state.general.volumeWidth, shallow);

export const useFollowCurrentSong = () =>
    useSettingsStore((state) => state.general.followCurrentSong, shallow);

export const useQueueInPlaybackOrder = () =>
    useSettingsStore((state) => state.general.queueInPlaybackOrder, shallow);

export const useShowFilesystemNameForFolders = () =>
    useSettingsStore((state) => state.general.showFilesystemNameForFolders, shallow);

export const useShowFilesystemNameForAlbums = () =>
    useSettingsStore((state) => state.general.showFilesystemNameForAlbums, shallow);

export const useAlbumFavoriteFilter = () =>
    useSettingsStore((state) => state.general.albumFavoriteFilter, shallow);

export const setAlbumFavoriteFilter = (value: boolean | null) => {
    useSettingsStore.setState((state) => {
        state.general.albumFavoriteFilter = value;
    });
};

export const useThemeSettings = () =>
    useSettingsStore(
        (state) => ({
            followSystemTheme: state.general.followSystemTheme,
            primaryShade: state.general.primaryShade,
            theme: state.general.theme,
            themeDark: state.general.themeDark,
            themeLight: state.general.themeLight,
            useThemeAccentColor: state.general.useThemeAccentColor,
            useThemePrimaryShade: state.general.useThemePrimaryShade,
        }),
        shallow,
    );

export const useSideQueueType = () =>
    useSettingsStore((state) => state.general.sideQueueType, shallow);

export const useSideQueueLayout = () =>
    useSettingsStore((state) => state.general.sideQueueLayout, shallow);

export const useVolumeWheelStep = () =>
    useSettingsStore((state) => state.general.volumeWheelStep, shallow);

export const useCollections = () => {
    const collections = useSettingsStore((state) => state.general.collections, shallow);

    return useMemo(
        () => [...(collections ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
        [collections],
    );
};

export const useSidebarPlaylistFolders = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistFolders, shallow);

export const useSidebarPlaylistFolderSeparator = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistFolderSeparator, shallow);

export const useSidebarPlaylistFolderView = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistFolderView, shallow);

export const useSidebarPlaylistFolderTreeIndent = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistFolderTreeIndent, shallow);

export const useSidebarPlaylistFolderTreeLineColor = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistFolderTreeLineColor, shallow);

export const useSidebarPlaylistList = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistList, shallow);

export const useSidebarBottomSection = () =>
    useSettingsStore((state) => state.general.sidebarBottomSection, shallow);

export const useMobileLibraryDestination = () =>
    useSettingsStore((state) => state.general.mobileLibraryDestination, shallow);

export const useMobilePlayerbarShowNavButtons = () =>
    useSettingsStore((state) => state.general.mobilePlayerbarShowNavButtons, shallow);

export const useMobileShellForce = () =>
    useSettingsStore((state) => state.general.mobileShellForce, shallow);

// `defaultCollapsed` applies only when the user hasn't explicitly toggled this
// section yet (no stored value). Callers pass `isMobileShell` so detail-header
// sections default to COLLAPSED on the mobile shell (where vertical space is
// precious) while staying expanded by default on desktop. Once the user toggles
// a section, their explicit choice (true/false) wins on every platform.
export const useDetailSectionCollapsed = (key: string, defaultCollapsed = false): boolean =>
    useSettingsStore((state) => {
        const stored = state.general.collapsedDetailSections?.[key];
        return stored === undefined ? defaultCollapsed : Boolean(stored);
    });

export const useSetDetailSectionCollapsed = () => {
    const { setSettings } = useSettingsStoreActions();
    return (key: string, collapsed: boolean) => {
        setSettings({
            general: {
                collapsedDetailSections: { [key]: collapsed },
            },
        });
    };
};

export const useSidebarPlaylistMode = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistMode, shallow);

export const useSidebarPlaylistSorting = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistSorting, shallow);

export const useSidebarPlaylistListFilterRegex = () =>
    useSettingsStore((state) => state.general.sidebarPlaylistListFilterRegex, shallow);

export const useSidebarItems = () =>
    useSettingsStore((state) => state.general.sidebarItems, shallow);

export const usePlayerItems = () => useSettingsStore((state) => state.general.playerItems, shallow);

export const useSidebarCollapsedNavigation = () =>
    useSettingsStore((state) => state.general.sidebarCollapsedNavigation, shallow);

export const usePlayerbarOpenDrawer = () =>
    useSettingsStore((state) => state.general.playerbarOpenDrawer, shallow);

export const useShowRatings = () => useSettingsStore((state) => state.general.showRatings, shallow);

export const useBlurExplicitImages = () =>
    useSettingsStore((state) => state.general.blurExplicitImages, shallow);

export const useEnableGridMultiSelect = () =>
    useSettingsStore((state) => state.general.enableGridMultiSelect, shallow);

export const usePrefetchSidebarAlbums = () =>
    useSettingsStore((state) => state.general.prefetchSidebarAlbums, shallow);

export const usePrefetchUpcomingLyrics = () =>
    useSettingsStore((state) => state.general.prefetchUpcomingLyrics, shallow);

export const usePrefetchUpcomingLyricsCount = () =>
    useSettingsStore((state) => state.general.prefetchUpcomingLyricsCount, shallow);

export const useArtistRadioCount = () =>
    useSettingsStore((state) => state.general.artistRadioCount, shallow);

export const useArtistPageSections = () =>
    useSettingsStore((state) => state.general.artistPageSections, shallow);

export const useArtistBackground = () =>
    useSettingsStore(
        (state) => ({
            artistBackground: state.general.artistBackground,
            artistBackgroundBlur: state.general.artistBackgroundBlur,
        }),
        shallow,
    );

export const useAlbumBackground = () =>
    useSettingsStore(
        (state) => ({
            albumBackground: state.general.albumBackground,
            albumBackgroundBlur: state.general.albumBackgroundBlur,
        }),
        shallow,
    );

export const useExternalLinks = () =>
    useSettingsStore(
        (state) => ({
            externalLinks: state.general.externalLinks,
            lastFM: state.general.lastFM,
            listenBrainz: state.general.listenBrainz,
            musicBrainz: state.general.musicBrainz,
            nativeSpotify: state.general.nativeSpotify,
            qobuz: state.general.qobuz,
            spotify: state.general.spotify,
        }),
        shallow,
    );

export const useGenresDisplay = () =>
    useSettingsStore((state) => state.general.genresDisplay, shallow);

export const useSocialLinksDisplay = () =>
    useSettingsStore((state) => state.general.socialLinksDisplay, shallow);

export const useGridCardCornerRadius = () =>
    useSettingsStore((state) => state.general.gridCardCornerRadius, shallow);

export const useGridCardSize = () =>
    useSettingsStore((state) => state.general.gridCardSize, shallow);

export const useGridGap = () => useSettingsStore((state) => state.general.gridGap, shallow);

export const useGridMetadataRows = () =>
    useSettingsStore((state) => state.general.gridMetadataRows, shallow);

export const useShowRatingBadge = () =>
    useSettingsStore((state) => state.general.showRatingBadge, shallow);

export const useHomeGreetingVisible = () =>
    useSettingsStore((state) => state.general.homeGreetingVisible, shallow);

export const useHomeCarouselItemsPerPage = () =>
    useSettingsStore((state) => state.general.homeCarouselItemsPerPage, shallow);

export const useHomeFeatureCardSongsPerCard = () =>
    useSettingsStore((state) => state.general.homeFeatureCardSongsPerCard, shallow);

export const useHomeFeatureCardRotationIntervalSeconds = () =>
    useSettingsStore((state) => state.general.homeFeatureCardRotationIntervalSeconds, shallow);

export const useHomeFeature = () => useSettingsStore((state) => state.general.homeFeature, shallow);

export const useHomeFeatureContent = () =>
    useSettingsStore((state) => state.general.homeFeatureContent);

export const useHomeFeatureStyle = () =>
    useSettingsStore((state) => state.general.homeFeatureStyle);

export const useHomeFeelingLucky = () =>
    useSettingsStore((state) => state.general.homeFeelingLucky);

export const useSleepTimerFadeSeconds = () =>
    useSettingsStore((state) => state.playback.sleepTimerFadeSeconds ?? 0);

export const useHomeItems = () => useSettingsStore((state) => state.general.homeItems, shallow);

export const useArtistItems = () => useSettingsStore((state) => state.general.artistItems, shallow);

export const useArtistReleaseTypeItems = () =>
    useSettingsStore((state) => state.general.artistReleaseTypeItems, shallow);

export const useZoomFactor = () => useSettingsStore((state) => state.general.zoomFactor, shallow);

export const usePathReplace = () =>
    useSettingsStore(
        (state) => ({
            pathReplace: state.general.pathReplace,
            pathReplaceWith: state.general.pathReplaceWith,
        }),
        shallow,
    );

export const useLastfmApiKey = () =>
    useSettingsStore((state) => state.general.lastfmApiKey, shallow);

export const useSidebarPanelOrder = () =>
    useSettingsStore((state) => state.general.sidebarPanelOrder, shallow);

export const useCombinedLyricsAndVisualizer = () =>
    useSettingsStore((state) => state.general.combinedLyricsAndVisualizer, shallow);

export const useShowLyricsInSidebar = () =>
    useSettingsStore((state) => state.general.showLyricsInSidebar, shallow);

export const useShowVisualizerInSidebar = () =>
    useSettingsStore((state) => state.general.showVisualizerInSidebar, shallow);

export const useShowPlaybarYearChip = () =>
    useSettingsStore((state) => state.general.showPlaybarYearChip, shallow);

export const useAutoDJSettings = () => useSettingsStore((store) => store.autoDJ, shallow);

export const useVisualizerSettings = () => useSettingsStore((store) => store.visualizer, shallow);

export const subscribeButterchurnPreset = (
    onChange: (preset: string | undefined, prevPreset: string | undefined) => void,
) => {
    return useSettingsStore.subscribe(
        (state) => state.visualizer.butterchurn.currentPreset,
        (preset, prevPreset) => {
            onChange(preset, prevPreset);
        },
    );
};

export const useButterchurnSettings = () => {
    return useSettingsStore((store) => {
        return {
            blendTime: store.visualizer.butterchurn.blendTime,
            cyclePresets: store.visualizer.butterchurn.cyclePresets,
            cycleTime: store.visualizer.butterchurn.cycleTime,
            ignoredPresets: store.visualizer.butterchurn.ignoredPresets,
            includeAllPresets: store.visualizer.butterchurn.includeAllPresets,
            maxFPS: store.visualizer.butterchurn.maxFPS,
            opacity: store.visualizer.butterchurn.opacity,
            randomizeNextPreset: store.visualizer.butterchurn.randomizeNextPreset,
            selectedPresets: store.visualizer.butterchurn.selectedPresets,
        };
    }, shallow);
};

export const useTrackmapEnabled = () =>
    useSettingsStore((state) => state.general.trackmapEnabled, shallow);

export const useTrackmapGlow = () =>
    useSettingsStore((state) => state.general.trackmapGlow, shallow);

export const useTrackmapHeight = () =>
    useSettingsStore((state) => state.general.trackmapHeight, shallow);

export const useTrackmapOnlyOverLan = () =>
    useSettingsStore((state) => state.general.trackmapOnlyOverLan, shallow);

export const useTrackmapSensitivity = () =>
    useSettingsStore((state) => state.general.trackmapSensitivity, shallow);

export const useTrackmapStyle = () =>
    useSettingsStore((state) => state.general.trackmapStyle, shallow);

/**
 * The 22 trackmap "advanced" knobs as a single shallow-compared object.
 * Aggregated so the canvas component doesn't need 22 individual selectors
 * (and so the JSON export can serialise them in one place). Only the
 * settings under this selector are considered "tunable visual params";
 * the master toggle / lan-only / sensitivity / height / glow / style
 * settings have their own individual selectors above because they're
 * the primary user-facing knobs.
 */
export const useTrackmapAdvanced = () =>
    useSettingsStore(
        useShallow((state) => ({
            bgGlowAlpha: state.general.trackmapBgGlowAlpha,
            breathAmplitudePct: state.general.trackmapBreathAmplitudePct,
            breathPeriodSec: state.general.trackmapBreathPeriodSec,
            colorBgGlow: state.general.trackmapColorBgGlow,
            colorCool: state.general.trackmapColorCool,
            colorStrandB: state.general.trackmapColorStrandB,
            colorWarm: state.general.trackmapColorWarm,
            dimMaskMin: state.general.trackmapDimMaskMin,
            dimMaskTransitionPx: state.general.trackmapDimMaskTransitionPx,
            envelopeFillAlpha: state.general.trackmapEnvelopeFillAlpha,
            envelopeOutlineAlpha: state.general.trackmapEnvelopeOutlineAlpha,
            envelopeOutlineWidthPx: state.general.trackmapEnvelopeOutlineWidthPx,
            haloBlurPx: state.general.trackmapHaloBlurPx,
            helixCycles: state.general.trackmapHelixCycles,
            helixRotationSec: state.general.trackmapHelixRotationSec,
            playheadGlowAlpha: state.general.trackmapPlayheadGlowAlpha,
            playheadShadowBlurPx: state.general.trackmapPlayheadShadowBlurPx,
            playheadWidthPx: state.general.trackmapPlayheadWidthPx,
            rungAlpha: state.general.trackmapRungAlpha,
            rungSpacingPx: state.general.trackmapRungSpacingPx,
            strandCrispAlpha: state.general.trackmapStrandCrispAlpha,
            strandHaloAlpha: state.general.trackmapStrandHaloAlpha,
        })),
    );

/** The shape of the advanced-knobs slice — exported for the canvas + UI. */
export type TrackmapAdvancedSettings = ReturnType<typeof useTrackmapAdvanced>;
