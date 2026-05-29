import type { ServerListItem } from '/@/shared/types/domain-types';
import type { TFunction } from 'i18next';

import { Capacitor } from '@capacitor/core';
import isElectron from 'is-electron';
import { ComponentType, lazy, ReactNode } from 'react';
import {
    RiAccountBoxLine,
    RiAlertLine,
    RiArrowUpDownLine,
    RiBracesLine,
    RiBroadcastLine,
    RiBugLine,
    RiCelsiusLine,
    RiCommandLine,
    RiDatabase2Line,
    RiDiscordLine,
    RiDownloadLine,
    RiEqualizer2Line,
    RiEqualizerLine,
    RiExternalLinkLine,
    RiEyeLine,
    RiFolderLine,
    RiGamepadLine,
    RiHomeLine,
    RiKey2Line,
    RiLayoutLeftLine,
    RiMagicLine,
    RiMicLine,
    RiMusicLine,
    RiPaletteLine,
    RiPlayCircleLine,
    RiPulseLine,
    RiRefreshLine,
    RiRemoteControlLine,
    RiServerLine,
    RiSettings4Line,
    RiShareForwardLine,
    RiSlideshowLine,
    RiTerminalBoxLine,
    RiThumbUpLine,
    RiTv2Line,
    RiVolumeUpLine,
    RiWindowLine,
} from 'react-icons/ri';

import { hasFeature } from '/@/shared/api/utils';
import { ServerFeature } from '/@/shared/types/features-types';

const isTouchOnly = () => {
    if (typeof window === 'undefined') return false;
    if (Capacitor.getPlatform() === 'android' || Capacitor.getPlatform() === 'ios') return true;
    return window.matchMedia('(pointer: coarse)').matches;
};

const isLinuxDesktop = () => isElectron() && Boolean(window.api?.utils?.isLinux?.());

export interface SubpageDef {
    // Accepts both eager and lazy-wrapped components. Subpages are rendered
    // inside <Suspense> upstream, so a LazyExoticComponent is the common case.
    Component: ComponentType;
    description?: (t: TFunction) => string;
    Icon: (props: { size?: string }) => ReactNode;
    id: string;
    label: (t: TFunction) => string;
    /**
     * Server-dependent visibility (e.g. smart playlists only on backends
     * that announce the feature). Receives the current server so the
     * caller can branch without us pulling Zustand at the top level
     * (manifest is module-scope and shouldn't subscribe to anything).
     */
    visible?: (server: null | ServerListItem | undefined) => boolean;
}

const lazyDefault = <T extends { [key: string]: any }>(
    loader: () => Promise<T>,
    exportName: keyof T,
) => lazy(() => loader().then((module) => ({ default: module[exportName] as () => ReactNode })));

// General
const ThemeSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/theme-settings'),
    'ThemeSettings',
);
const ApplicationSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/application-settings'),
    'ApplicationSettings',
);
const ExternalLinksSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/external-links-settings'),
    'ExternalLinksSettings',
);
const ControlSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/control-settings'),
    'ControlSettings',
);
const SidebarSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/sidebar-settings'),
    'SidebarSettings',
);
const ScrobbleSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/scrobble-settings'),
    'ScrobbleSettings',
);
const LyricsSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/lyric-settings'),
    'LyricSettings',
);
const TrackmapSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/trackmap-settings'),
    'TrackmapSettings',
);
const QueryBuilderSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/query-builder-settings'),
    'QueryBuilderSettings',
);
const HomeSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/home-settings'),
    'HomeSettings',
);
const ArtistSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/artist-settings'),
    'ArtistSettings',
);
const ArtResolutionSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/art-resolution-settings'),
    'ImageResolutionSettings',
);
const PathSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/path-settings'),
    'PathSettings',
);
const FullscreenPlayerSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/general/fullscreen-player-settings'),
    'FullscreenPlayerSettings',
);

// Playback
const AudioSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/playback/audio-settings'),
    'AudioSettings',
);
const MpvSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/playback/mpv-settings'),
    'MpvSettings',
);
const TranscodeSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/playback/transcode-settings'),
    'TranscodeSettings',
);
const PlayerFilterSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/playback/player-filter-settings'),
    'PlayerFilterSettings',
);
const AutoDjSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/playback/auto-dj-settings'),
    'AutoDJSettings',
);
const PrefetchSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/playback/prefetch-settings'),
    'PrefetchSettings',
);

// Hotkeys
const WindowHotkeySubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/hotkeys/window-hotkey-settings'),
    'WindowHotkeySettings',
);
const MediaSessionSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/hotkeys/media-session-settings'),
    'MediaSessionSettings',
);
const HotkeyManagerSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/hotkeys/hotkey-manager-settings'),
    'HotkeyManagerSettings',
);

// Window
const WindowSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/window-settings'),
    'WindowSettings',
);
const DiscordSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/discord-settings'),
    'DiscordSettings',
);
const RemoteSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/remote-settings'),
    'RemoteSettings',
);
const PasswordSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/password-settings'),
    'PasswordSettings',
);
const PeerSyncSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/peer-sync-settings'),
    'PeerSyncSettings',
);
const ConnectDiagnosticsSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/connect/connect-diagnostics-settings'),
    'ConnectDiagnosticsSettings',
);
const ConnectWizardSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/connect/connect-wizard'),
    'ConnectWizard',
);
const OfflineMediaSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/connect/offline-media-settings'),
    'OfflineMediaSettings',
);

// Advanced
const UpdateSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/update-settings'),
    'UpdateSettings',
);
const ServerInfoSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/server-info-widget'),
    'ServerInfoWidget',
);
const JellyfinServerActionsSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/jellyfin-server-actions'),
    'JellyfinServerActions',
);
const AnalyticsSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/analytics-settings'),
    'AnalyticsSettings',
);
const MobileOverridesSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/mobile-overrides-settings'),
    'MobileOverridesSettings',
);
const ExportImportSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/export-import-settings'),
    'ExportImportSettings',
);
const LoggerSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/logger-settings'),
    'LoggerSettings',
);
const CacheSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/window/cache-settngs'),
    'CacheSettings',
);
const LibrarySyncSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/library-sync-settings'),
    'LibrarySyncSettings',
);
const StylesSubpage = lazyDefault(
    () => import('/@/renderer/features/settings/components/advanced/styles-settings'),
    'StylesSettings',
);

export const SETTINGS_SUBPAGES: Record<string, SubpageDef[]> = {
    advanced: [
        {
            Component: UpdateSubpage,
            description: (t) =>
                t('page.setting.updateDescription', {
                    defaultValue: 'Auto-update channel + release source.',
                }),
            Icon: RiRefreshLine,
            id: 'updates',
            label: (t) => t('page.setting.updates', { defaultValue: 'Updates' }),
        },
        {
            Component: ServerInfoSubpage,
            description: (t) =>
                t('page.setting.serverInfoDescription', {
                    defaultValue: 'Connected server diagnostics.',
                }),
            Icon: RiServerLine,
            id: 'server-info',
            label: (t) => t('page.setting.serverInfo', { defaultValue: 'Server info' }),
        },
        {
            Component: JellyfinServerActionsSubpage,
            description: (t) =>
                t('page.setting.jellyfinActionsDescription', {
                    defaultValue: 'Library rescan and other server-side actions.',
                }),
            Icon: RiSlideshowLine,
            id: 'jellyfin-actions',
            label: (t) => t('page.setting.jellyfinActions', { defaultValue: 'Jellyfin actions' }),
        },
        {
            Component: StylesSubpage,
            description: (t) =>
                t('page.setting.customCssDescription', {
                    defaultValue: 'User stylesheet for power-users.',
                }),
            Icon: RiPaletteLine,
            id: 'custom-css',
            label: (t) => t('page.setting.customCss', { defaultValue: 'Custom CSS' }),
        },
        {
            Component: AnalyticsSubpage,
            description: (t) =>
                t('page.setting.analyticsDescription', {
                    defaultValue: 'Opt-in anonymous usage telemetry.',
                }),
            Icon: RiShareForwardLine,
            id: 'analytics',
            label: (t) => t('page.setting.analytics', { defaultValue: 'Analytics' }),
        },
        {
            Component: MobileOverridesSubpage,
            description: (t) =>
                t('page.setting.mobileOverridesDescription', {
                    defaultValue: 'Force mobile shell on desktop and similar overrides.',
                }),
            Icon: RiArrowUpDownLine,
            id: 'mobile-overrides',
            label: (t) => t('page.setting.mobileOverrides', { defaultValue: 'Mobile overrides' }),
        },
        {
            Component: ExportImportSubpage,
            description: (t) =>
                t('page.setting.exportImportDescription', {
                    defaultValue: 'Backup and restore settings.',
                }),
            Icon: RiMusicLine,
            id: 'export-import',
            label: (t) => t('page.setting.exportImport', { defaultValue: 'Backup' }),
        },
        {
            Component: LoggerSubpage,
            description: (t) =>
                t('page.setting.loggerDescription', {
                    defaultValue: 'Inspect runtime logs (debugging only).',
                }),
            Icon: RiBugLine,
            id: 'logger',
            label: (t) => t('page.setting.logger', { defaultValue: 'Logs' }),
        },
        {
            Component: CacheSubpage,
            description: (t) =>
                t('page.setting.cacheDescription', {
                    defaultValue: 'Clear cached cover art and stream data.',
                }),
            Icon: RiDatabase2Line,
            id: 'cache',
            label: (t) => t('page.setting.cache', { defaultValue: 'Cache' }),
        },
        {
            Component: TerminalAccessNote,
            description: (t) =>
                t('page.setting.touchOnlyHelpDescription', {
                    defaultValue: 'Where to look on a phone that has no keyboard.',
                }),
            Icon: RiAlertLine,
            id: 'touch-only-help',
            label: (t) => t('page.setting.touchOnlyHelp', { defaultValue: 'Touch-only help' }),
            visible: () => isTouchOnly(),
        },
    ],
    connect: [
        {
            Component: ConnectWizardSubpage,
            description: (t) =>
                t('page.setting.connectWizardDescription', {
                    defaultValue:
                        'Step-by-step setup for Jellyfin Connect remote-play and peer MQTT sync.',
                }),
            Icon: RiMagicLine,
            id: 'wizard',
            label: (t) => t('page.setting.connectWizard', { defaultValue: 'Setup wizard' }),
        },
        {
            Component: PeerSyncSubpage,
            description: (t) =>
                t('page.setting.peerSyncDescription', {
                    defaultValue: 'Low-latency direct sync between Feishin instances over MQTT.',
                }),
            Icon: RiBroadcastLine,
            id: 'peer-sync',
            label: (t) => t('page.setting.peerSync', { defaultValue: 'Jellyfin Connect (MQTT)' }),
        },
        {
            Component: LibrarySyncSubpage,
            description: (t) =>
                t('page.setting.librarySyncDescription', {
                    defaultValue: 'Local-first cache for the Jellyfin library.',
                }),
            Icon: RiDatabase2Line,
            id: 'library-sync',
            label: (t) => t('page.setting.librarySync', { defaultValue: 'Library sync' }),
            visible: (server) => server?.type === 'jellyfin',
        },
        {
            Component: OfflineMediaSubpage,
            description: (t) =>
                t('page.setting.offlineMediaDescription', {
                    defaultValue: 'Download albums and playlists for offline playback.',
                }),
            Icon: RiDownloadLine,
            id: 'offline-media',
            label: (t) => t('page.setting.offlineMedia', { defaultValue: 'Offline downloads' }),
            visible: (server) => server?.type === 'jellyfin',
        },
        {
            Component: ConnectDiagnosticsSubpage,
            description: (t) =>
                t('page.setting.connectDiagnosticsDescription', {
                    defaultValue:
                        'Live transport, peer presence, recent commands, and round-trip latency.',
                }),
            Icon: RiPulseLine,
            id: 'diagnostics',
            label: (t) => t('page.setting.connectDiagnostics', { defaultValue: 'Diagnostics' }),
        },
        {
            Component: RemoteSubpage,
            description: (t) =>
                t('page.setting.remoteDescription', {
                    defaultValue: 'Companion web remote on the LAN.',
                }),
            Icon: RiRemoteControlLine,
            id: 'remote',
            label: (t) => t('page.setting.remote', { defaultValue: 'Remote control' }),
            visible: () => isElectron(),
        },
    ],
    general: [
        {
            Component: ApplicationSubpage,
            description: (t) =>
                t('page.setting.applicationDescription', {
                    defaultValue: 'Language, behaviour, system integrations.',
                }),
            Icon: RiSettings4Line,
            id: 'application',
            label: (t) => t('page.setting.application', { defaultValue: 'Application' }),
        },
        {
            Component: ThemeSubpage,
            description: (t) =>
                t('page.setting.themeDescription', {
                    defaultValue: 'Light / dark themes, accent colour, fonts.',
                }),
            Icon: RiPaletteLine,
            id: 'theme',
            label: (t) => t('page.setting.theme', { defaultValue: 'Appearance' }),
        },
        {
            Component: HomeSubpage,
            description: (t) =>
                t('page.setting.homeDescription', {
                    defaultValue: 'What sections appear on the home page.',
                }),
            Icon: RiHomeLine,
            id: 'home',
            label: (t) => t('page.setting.home', { defaultValue: 'Home' }),
        },
        {
            Component: SidebarSubpage,
            description: (t) =>
                t('page.setting.sidebarDescription', {
                    defaultValue: 'Sidebar layout and pinned items.',
                }),
            Icon: RiLayoutLeftLine,
            id: 'sidebar',
            label: (t) => t('page.setting.sidebar', { defaultValue: 'Sidebar' }),
        },
        {
            Component: ControlSubpage,
            description: (t) =>
                t('page.setting.controlsDescription', {
                    defaultValue: 'Player bar layout, transport buttons.',
                }),
            Icon: RiGamepadLine,
            id: 'controls',
            label: (t) => t('page.setting.controls', { defaultValue: 'Controls' }),
        },
        {
            Component: FullscreenPlayerSubpage,
            description: (t) =>
                t('page.setting.fullscreenPlayerDescription', {
                    defaultValue: 'Dynamic backgrounds, image blur, opacity.',
                }),
            Icon: RiTv2Line,
            id: 'fullscreen-player',
            label: (t) => t('page.setting.fullscreenPlayer', { defaultValue: 'Fullscreen player' }),
        },
        {
            Component: TrackmapSubpage,
            description: (t) =>
                t('page.setting.trackmapDescription', {
                    defaultValue: 'Behind-the-music spectrum visual under the mini player.',
                }),
            Icon: RiPulseLine,
            id: 'trackmap',
            label: (t) => t('page.setting.trackmap', { defaultValue: 'Trackmap' }),
        },
        {
            Component: LyricsSubpage,
            description: (t) =>
                t('page.setting.lyricsDescription', {
                    defaultValue: 'Lyric providers, fonts, offsets.',
                }),
            Icon: RiMicLine,
            id: 'lyrics',
            label: (t) => t('page.setting.lyrics', { defaultValue: 'Lyrics' }),
        },
        {
            Component: ScrobbleSubpage,
            description: (t) =>
                t('page.setting.scrobbleDescription', {
                    defaultValue: 'Last.fm / Listenbrainz reporting + notifications.',
                }),
            Icon: RiThumbUpLine,
            id: 'scrobble',
            label: (t) => t('page.setting.scrobble', { defaultValue: 'Scrobbling' }),
        },
        {
            Component: ArtistSubpage,
            description: (t) =>
                t('page.setting.artistDescription', {
                    defaultValue: 'Layout and metadata shown on artist pages.',
                }),
            Icon: RiAccountBoxLine,
            id: 'artist',
            label: (t) => t('page.setting.artist', { defaultValue: 'Artist page' }),
        },
        {
            Component: ArtResolutionSubpage,
            description: (t) =>
                t('page.setting.artResolutionDescription', {
                    defaultValue: 'Cover-art image quality per surface.',
                }),
            Icon: RiEyeLine,
            id: 'art-resolution',
            label: (t) => t('page.setting.artResolution', { defaultValue: 'Cover art quality' }),
        },
        {
            Component: ExternalLinksSubpage,
            description: (t) =>
                t('page.setting.externalLinksDescription', {
                    defaultValue: 'Right-click "open in…" service links.',
                }),
            Icon: RiExternalLinkLine,
            id: 'external-links',
            label: (t) => t('page.setting.externalLinks', { defaultValue: 'External links' }),
        },
        {
            Component: PathSubpage,
            description: (t) =>
                t('page.setting.pathDescription', {
                    defaultValue: 'Local download / cache directories.',
                }),
            Icon: RiFolderLine,
            id: 'paths',
            label: (t) => t('page.setting.paths', { defaultValue: 'Paths' }),
            visible: () => isElectron(),
        },
        {
            Component: QueryBuilderSubpage,
            description: (t) =>
                t('page.setting.queryBuilderDescription', {
                    defaultValue: 'Smart-playlist query builder defaults.',
                }),
            Icon: RiBracesLine,
            id: 'query-builder',
            label: (t) => t('page.setting.queryBuilder', { defaultValue: 'Smart playlists' }),
            visible: (server) => hasFeature(server ?? null, ServerFeature.PLAYLISTS_SMART),
        },
    ],
    hotkeys: [
        {
            Component: WindowHotkeySubpage,
            description: (t) =>
                t('page.setting.windowHotkeysDescription', {
                    defaultValue: 'OS-level global hotkeys.',
                }),
            Icon: RiKey2Line,
            id: 'window-hotkeys',
            label: (t) => t('page.setting.windowHotkeysTab', { defaultValue: 'Global hotkeys' }),
            visible: () => isElectron(),
        },
        {
            Component: MediaSessionSubpage,
            description: (t) =>
                t('page.setting.mediaSessionDescription', {
                    defaultValue: 'OS media keys + headphone remote.',
                }),
            Icon: RiPulseLine,
            id: 'media-session',
            label: (t) => t('page.setting.mediaSession', { defaultValue: 'Media keys' }),
        },
        {
            Component: HotkeyManagerSubpage,
            description: (t) =>
                t('page.setting.hotkeyManagerDescription', {
                    defaultValue: 'Per-action keyboard shortcuts.',
                }),
            Icon: RiCommandLine,
            id: 'hotkey-manager',
            label: (t) => t('page.setting.hotkeyManager', { defaultValue: 'Bindings' }),
        },
    ],
    playback: [
        {
            Component: AudioSubpage,
            description: (t) =>
                t('page.setting.audioDescription', {
                    defaultValue: 'Engine, web audio, audio device.',
                }),
            Icon: RiVolumeUpLine,
            id: 'audio',
            label: (t) => t('page.setting.audio', { defaultValue: 'Audio' }),
        },
        {
            Component: MpvSubpage,
            description: (t) =>
                t('page.setting.mpvDescription', {
                    defaultValue: 'MPV engine parameters and extras.',
                }),
            Icon: RiPlayCircleLine,
            id: 'mpv',
            label: (t) => t('page.setting.mpv', { defaultValue: 'MPV' }),
            visible: () => isElectron(),
        },
        {
            Component: TranscodeSubpage,
            description: (t) =>
                t('page.setting.transcodeDescription', {
                    defaultValue: 'Server-side transcoding profiles + bitrate.',
                }),
            Icon: RiCelsiusLine,
            id: 'transcode',
            label: (t) => t('page.setting.transcode', { defaultValue: 'Transcoding' }),
        },
        {
            Component: PlayerFilterSubpage,
            description: (t) =>
                t('page.setting.filtersDescription', {
                    defaultValue: 'ReplayGain, crossfade, gapless.',
                }),
            Icon: RiEqualizerLine,
            id: 'filters',
            label: (t) => t('page.setting.filters', { defaultValue: 'Filters' }),
        },
        {
            Component: AutoDjSubpage,
            description: (t) =>
                t('page.setting.autoDjDescription', {
                    defaultValue: 'Background queue extension via similar tracks.',
                }),
            Icon: RiEqualizer2Line,
            id: 'auto-dj',
            label: (t) => t('page.setting.autoDj', { defaultValue: 'Auto DJ' }),
        },
        {
            Component: PrefetchSubpage,
            description: (t) =>
                t('page.setting.prefetchDescription', {
                    defaultValue: 'Preload next track for instant transitions.',
                }),
            Icon: RiDownloadLine,
            id: 'prefetch',
            label: (t) => t('page.setting.prefetch', { defaultValue: 'Prefetch' }),
        },
    ],
    window: [
        {
            Component: WindowSubpage,
            description: (t) =>
                t('page.setting.windowDescription', {
                    defaultValue: 'Native chrome, tray icon, startup.',
                }),
            Icon: RiWindowLine,
            id: 'window',
            label: (t) => t('page.setting.window', { defaultValue: 'Window' }),
        },
        {
            Component: DiscordSubpage,
            description: (t) =>
                t('page.setting.discordDescription', {
                    defaultValue: 'Rich Presence integration.',
                }),
            Icon: RiDiscordLine,
            id: 'discord',
            label: (t) => t('page.setting.discord', { defaultValue: 'Discord' }),
        },
        {
            Component: PasswordSubpage,
            description: (t) =>
                t('page.setting.passwordDescription', {
                    defaultValue: 'OS keychain credential storage.',
                }),
            Icon: RiKey2Line,
            id: 'password',
            label: (t) => t('page.setting.password', { defaultValue: 'Keychain' }),
            visible: () => isLinuxDesktop(),
        },
    ],
};

// Tiny inline component for the touch-only help subpage — explains
// what keyboard-bound features are unavailable on phones.
function TerminalAccessNote() {
    return (
        <div style={{ padding: '1rem 0' }}>
            <p style={{ color: 'rgb(255 255 255 / 70%)', fontSize: '0.95rem', lineHeight: 1.5 }}>
                Hotkeys, the developer logger panel, and the Linux keychain integration are
                desktop-only and don&apos;t appear on a touch device. If you need them, switch to
                the Electron build on your laptop and sync settings via Backup.
            </p>
        </div>
    );
}

// Convenience used by the layout — also wired into the icon rendering
// pattern for category-level rows. Exported separately so the layout
// can use `Icon as IconType` and not couple to react-icons internals.
export const SUBPAGE_FALLBACK_ICON = RiTerminalBoxLine;
