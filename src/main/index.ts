import { is } from '@electron-toolkit/utils';
import {
    app,
    BrowserWindow,
    BrowserWindowConstructorOptions,
    desktopCapturer,
    globalShortcut,
    ipcMain,
    Menu,
    nativeImage,
    nativeTheme,
    net,
    Notification,
    powerSaveBlocker,
    protocol,
    Rectangle,
    screen,
    session,
    shell,
    Tray,
} from 'electron';
import electronLocalShortcut from 'electron-localshortcut';
import { autoUpdater } from 'electron-updater';
import { constants } from 'fs';
import { access } from 'fs/promises';
import path, { join } from 'path';

import packageJson from '../../package.json';
import { loadDeferredCoreFeatures } from './features';
import { disableMediaKeys, enableMediaKeys } from './features/core/player/media-keys';
import { shutdownServer } from './features/core/remote';
import { store } from './features/core/settings';
import { canHandleVisualizerDisplayMedia } from './features/core/visualizer';
import log, { autoUpdaterLogInterface } from './logger';
import './features';
import MenuBuilder, { MenuPlaybackState } from './menu';
import { hotkeyToElectronAccelerator } from './utils';

import { disableAutoUpdates, isLinux, isMacOS, isWindows } from '/@/main/env';
import {
    clampWindowBoundsToDisplay,
    DEFAULT_WINDOW_BOUNDS,
    resolveWindowBounds,
} from '/@/main/utils/window-bounds';
import { PlayerRepeat, PlayerStatus, PlayerType, TitleTheme } from '/@/shared/types/types';

// Point the desktop autoUpdater at the fork's releases rather than upstream
// jeffvli/feishin so users on this build actually receive the fork's updates.
// The web/Android side polls the same repo via use-github-releases-updater.ts
// so every platform converges on a single source of truth.
const GITHUB_UPDATER_CONFIG = {
    owner: 'itskenny0',
    provider: 'github' as const,
    repo: 'feishin',
};

type UpdaterInstance = typeof autoUpdater;

// The fork is a single rolling release channel: always pull the newest GitHub
// release from GITHUB_UPDATER_CONFIG. A leftover upstream `release_channel`
// (alpha/beta) in the main store must not steer the updater, since the fork
// publishes no alpha/beta channel files.
class AppUpdater {
    constructor() {
        const updater = configureAndGetUpdater();
        attachUpdaterMilestoneLogs(updater);

        if (isMacOS()) {
            autoUpdater.autoDownload = false;
            autoUpdater
                .checkForUpdates()
                .then((result) => {
                    if (result?.isUpdateAvailable) {
                        log.info('Updater check complete', {
                            available: true,
                            version: result.updateInfo.version,
                        });
                        getMainWindow()?.webContents.send(
                            'update-available',
                            result.updateInfo.version,
                        );
                    } else {
                        log.info('Updater check complete', { available: false });
                    }
                })
                .catch((err) => log.error('Check for updates failed', err));
        } else {
            autoUpdater
                .checkForUpdatesAndNotify()
                .catch((err) => log.error('Check for updates failed', err));
        }
    }
}

function attachUpdaterMilestoneLogs(updater: UpdaterInstance): void {
    let downloadStarted = false;

    updater.on('checking-for-update', () => {
        log.info('Updater checking for update');
    });

    updater.on('update-available', (info) => {
        log.info('Updater update available', { version: info.version });
    });

    updater.on('update-not-available', (info) => {
        log.info('Updater update not available', { version: info.version });
    });

    updater.on('download-progress', () => {
        if (!downloadStarted) {
            downloadStarted = true;
            log.info('Updater download starting');
        }
    });

    updater.on('update-downloaded', (info) => {
        log.info('Updater download complete', { version: info.version });
    });

    updater.on('error', (error) => {
        log.error('Updater error', error);
    });
}

function configureAndGetUpdater(): UpdaterInstance {
    autoUpdater.logger = autoUpdaterLogInterface;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    // Pin the feed at runtime so the fork always pulls releases from
    // itskenny0/feishin regardless of the bundled app-update.yml.
    autoUpdater.setFeedURL(GITHUB_UPDATER_CONFIG);
    autoUpdater.channel = 'latest';
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;

    return autoUpdater;
}

protocol.registerSchemesAsPrivileged([
    { privileges: { bypassCSP: true, corsEnabled: true }, scheme: 'feishin' },
]);

process.on('uncaughtException', (error: any) => {
    log.error('Error in main process', error);
});

process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection in main process', reason);
});

if (store.get('ignore_ssl')) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
}

// From https://github.com/tutao/tutanota/commit/92c6ed27625fcf367f0fbcc755d83d7ff8fde94b
if (isLinux() && !process.argv.some((a) => a.startsWith('--password-store='))) {
    const passwordStore = store.get('password_store', 'gnome-libsecret') as string;
    app.commandLine.appendSwitch('password-store', passwordStore);
}

let mainWindow: BrowserWindow | null = null;
let tray: null | Tray = null;
// [sync-only] The currently-shown background-sync notification (replaced as
// progress advances) + a throttle timestamp so we don't re-post on every tick.
let syncProgressNotification: Notification | null = null;
let lastSyncNotificationAt = 0;
let exitFromTray = false;
let forceQuit = false;
let powerSaveBlockerId: null | number = null;
let menuBuilder: MenuBuilder | null = null;
// Renderer playback/UI state mirrored into the macOS application menu.
const menuState: MenuPlaybackState = {
    accelerators: {},
    inputFocused: false,
    playbackStatus: PlayerStatus.PAUSED,
    privateMode: false,
    repeatMode: PlayerRepeat.NONE,
    shuffleEnabled: false,
    sidebarCollapsed: false,
};

app.on('before-quit', () => {
    forceQuit = true;
    log.info('App quitting', { reason: exitFromTray ? 'tray' : 'before-quit' });
});
// The auto-update network check is deferred to `ready-to-show` (off the
// cold-start critical path). This guards against firing it more than once
// for the primary window.
let appUpdaterStarted = false;

ipcMain.on('input-focus-state', (_event, focused: boolean) => {
    const next = !!focused;
    if (menuState.inputFocused === next) return;
    menuState.inputFocused = next;
    if (isMacOS()) {
        updateMainMenu();
    }
});

if (process.env.NODE_ENV === 'production') {
    import('source-map-support').then((sourceMapSupport) => {
        sourceMapSupport.install();
    });
}

const isDevelopment = process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDevelopment) {
    import('electron-debug').then((electronDebug) => {
        electronDebug.default();
    });
}

const installExtensions = async () => {
    import('electron-devtools-installer').then((installer) => {
        const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
        const extensions = ['REACT_DEVELOPER_TOOLS', 'REDUX_DEVTOOLS'];

        installer
            .installExtension(
                extensions.map((name) => installer[name]),
                { forceDownload },
            )
            .then((installedExtensions) => {
                log.info(`Installed extension: ${installedExtensions}`);
            })
            .catch(() => {
                // Ignore
            });
    });
};

const userDataPath = app.getPath('userData');

if (isDevelopment) {
    const devUserDataPath = `${userDataPath}-dev`;
    app.setPath('userData', devUserDataPath);
}

const RESOURCES_PATH = app.isPackaged
    ? path.join(path.dirname(app.getAppPath()), 'assets')
    : path.join(__dirname, '../../assets');

const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
};

export const getMainWindow = () => {
    return mainWindow;
};

const hideMainWindowToTray = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.setSkipTaskbar(true);
    mainWindow.hide();
};

export const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        void createWindow(false);
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
    createWinThumbarButtons();
};

const rebuildMainMenu = () => {
    if (!menuBuilder || !mainWindow) return;

    menuBuilder.buildMenu(menuState);
};

const updateMainMenu = () => {
    if (!menuBuilder || !mainWindow) return;

    menuBuilder.updateMenu(menuState);
};

export const sendToastToRenderer = ({
    message,
    type,
}: {
    message: string;
    type: 'error' | 'info' | 'success' | 'warning';
}) => {
    getMainWindow()?.webContents.send('toast-from-main', {
        message,
        type,
    });
};

const createWinThumbarButtons = () => {
    if (isWindows()) {
        getMainWindow()?.setThumbarButtons([
            {
                click: () => getMainWindow()?.webContents.send('renderer-player-previous'),
                icon: nativeImage.createFromPath(getAssetPath('skip-previous.png')),
                tooltip: 'Previous Track',
            },
            {
                click: () => getMainWindow()?.webContents.send('renderer-player-play-pause'),
                icon: nativeImage.createFromPath(getAssetPath('play-circle.png')),
                tooltip: 'Play/Pause',
            },
            {
                click: () => getMainWindow()?.webContents.send('renderer-player-next'),
                icon: nativeImage.createFromPath(getAssetPath('skip-next.png')),
                tooltip: 'Next Track',
            },
        ]);
    }
};

const createTray = () => {
    let trayIcon: Electron.NativeImage | string;

    if (isMacOS()) {
        const iconPath = getAssetPath('icons/IconTemplate.png');
        const icon = nativeImage.createFromPath(iconPath);
        icon.setTemplateImage(true);
        trayIcon = icon;
    } else if (isLinux()) {
        trayIcon = getAssetPath('icons/icon.png');
    } else {
        trayIcon = getAssetPath('icons/icon.ico');
    }

    tray = new Tray(trayIcon);

    const contextMenu = Menu.buildFromTemplate([
        {
            click: () => {
                getMainWindow()?.webContents.send('renderer-player-play-pause');
            },
            label: 'Play/Pause',
        },
        {
            click: () => {
                getMainWindow()?.webContents.send('renderer-player-next');
            },
            label: 'Next Track',
        },
        {
            click: () => {
                getMainWindow()?.webContents.send('renderer-player-previous');
            },
            label: 'Previous Track',
        },
        {
            click: () => {
                getMainWindow()?.webContents.send('renderer-player-stop');
            },
            label: 'Stop',
        },
        {
            type: 'separator',
        },
        {
            click: showMainWindow,
            label: 'Open main window',
        },
        {
            click: () => {
                exitFromTray = true;
                app.quit();
            },
            label: 'Quit',
        },
    ]);

    if (!isMacOS()) {
        tray.on('click', () => {
            if (store.get('window_minimize_to_tray') && mainWindow?.isVisible()) {
                hideMainWindowToTray();
            } else {
                showMainWindow();
            }
        });
    }

    tray.setToolTip('Feishin');
    tray.setContextMenu(contextMenu);
};

const validateUrl = (url: string): boolean => {
    // Minor security, really. Enforce only loading websites (http/https). file://
    // URLs and the like should've already been blocked, but this is another check.
    // Note that arbitrary web URLs are still allowed under this scheme, although
    // that should really only be hit by Subsonic share url (or if artist homepage
    // is allowed for ND extensions)
    return url.startsWith('http://') || url.startsWith('https://');
};

async function createWindow(first = true): Promise<void> {
    if (isDevelopment) {
        await installExtensions().catch((error) => log.error(error));
    }

    const nativeFrame = store.get('window_window_bar_style', 'linux') === 'linux';
    store.set('window_has_frame', nativeFrame);

    const nativeFrameConfig: Record<string, BrowserWindowConstructorOptions> = {
        linux: {
            autoHideMenuBar: true,
            frame: true,
        },
        macOS: {
            autoHideMenuBar: true,
            frame: true,
            titleBarStyle: 'default',
            trafficLightPosition: { x: 10, y: 10 },
        },
        windows: {
            autoHideMenuBar: true,
            frame: true,
        },
    };

    const savedBounds = store.get('bounds') as Rectangle | undefined;
    const workArea = (
        savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)
            ? screen.getDisplayMatching(savedBounds)
            : screen.getPrimaryDisplay()
    ).workArea;
    const windowBounds = resolveWindowBounds(savedBounds, workArea);

    if (
        savedBounds &&
        (windowBounds.width !== savedBounds.width || windowBounds.height !== savedBounds.height)
    ) {
        log.warn('Clamped window bounds to display', {
            saved: savedBounds,
            windowBounds,
            workArea,
        });
    }

    // Create the browser window.
    mainWindow = new BrowserWindow({
        autoHideMenuBar: true,
        frame: false,
        icon: isWindows() ? getAssetPath('icons/icon.ico') : getAssetPath('icons/icon.png'),
        minHeight: 120,
        minWidth: 480,
        show: false,
        webPreferences: {
            allowRunningInsecureContent: !!store.get('ignore_ssl'),
            backgroundThrottling: false,
            contextIsolation: true,
            devTools: true,
            nodeIntegration: false,
            preload: join(__dirname, '../preload/index.js'),
            // Must stay false: this fork's preload imports node-backed code
            // (e.g. getHostname → main/utils → electron-log/main) and exposes
            // node-using APIs over contextBridge. A sandboxed preload can't
            // `require` those modules, so enabling sandbox makes the preload
            // fail to load — window.api ends up undefined and the renderer
            // black-screens (TypeError reading 'mpvPlayer'). contextIsolation
            // + nodeIntegration:false still apply.
            sandbox: false,
            webSecurity: !store.get('ignore_cors'),
        },
        ...(nativeFrame && isLinux() && nativeFrameConfig.linux),
        ...(nativeFrame && isMacOS() && nativeFrameConfig.macOS),
        ...(nativeFrame && isWindows() && nativeFrameConfig.windows),
        ...DEFAULT_WINDOW_BOUNDS,
        ...windowBounds,
    });

    electronLocalShortcut.register(mainWindow, 'Ctrl+Shift+I', () => {
        mainWindow?.webContents.openDevTools();
    });

    ipcMain.on('window-dev-tools', () => {
        mainWindow?.webContents.openDevTools();
    });

    ipcMain.on('window-maximize', () => {
        mainWindow?.maximize();
    });

    ipcMain.on('window-unmaximize', () => {
        mainWindow?.unmaximize();
    });

    ipcMain.on('window-minimize', () => {
        if (store.get('window_minimize_to_tray') === true) {
            log.info('Main window minimized to tray');
            hideMainWindowToTray();
        } else {
            mainWindow?.minimize();
        }
    });

    ipcMain.on('window-close', () => {
        mainWindow?.close();
    });

    ipcMain.on('window-quit', () => {
        log.info('App quitting', { reason: 'window-quit' });
        shutdownServer();
        mainWindow?.close();
        app.exit();
    });

    ipcMain.handle('window-clear-cache', async () => {
        return mainWindow?.webContents.session.clearCache();
    });

    // [sync-only] First-sync / background-sync progress → taskbar/dock progress
    // bar + a persistent OS notification while the window is hidden. The
    // renderer pushes { fraction, title, body, active } updates as the library
    // cache sweep advances; we mirror them onto the OS chrome so the user sees
    // progress without the window in front. `fraction` is 0..1, or -1 for an
    // indeterminate phase. `active: false` clears everything (sync done/idle).
    ipcMain.on(
        'sync-progress',
        (
            _event,
            payload: { active: boolean; body?: string; fraction?: number; title?: string },
        ) => {
            if (!mainWindow) return;
            const { active, body, fraction, title } = payload ?? {};
            if (!active) {
                mainWindow.setProgressBar(-1);
                if (syncProgressNotification) {
                    syncProgressNotification.close();
                    syncProgressNotification = null;
                }
                return;
            }
            // -1 → indeterminate; otherwise clamp to [0,1].
            const value = typeof fraction === 'number' && fraction >= 0 ? Math.min(1, fraction) : 2; // Electron treats >1 as "indeterminate" mode.
            mainWindow.setProgressBar(value);

            // Only surface a notification while the window is hidden/minimized
            // — when it's visible the in-app dashboard already shows progress.
            const hidden = !mainWindow.isVisible() || mainWindow.isMinimized();
            if (hidden && Notification.isSupported()) {
                const now = Date.now();
                if (now - lastSyncNotificationAt >= 4000) {
                    lastSyncNotificationAt = now;
                    if (syncProgressNotification) syncProgressNotification.close();
                    syncProgressNotification = new Notification({
                        body: body ?? '',
                        silent: true,
                        title: title ?? 'Syncing library',
                    });
                    syncProgressNotification.show();
                }
            } else if (!hidden && syncProgressNotification) {
                syncProgressNotification.close();
                syncProgressNotification = null;
            }
        },
    );

    ipcMain.on('app-restart', () => {
        // Fix for .AppImage
        if (process.env.APPIMAGE) {
            app.exit();
            app.relaunch({
                args: process.argv.slice(1).concat(['--appimage-extract-and-run']),
                execPath: process.env.APPIMAGE,
            });
            app.exit(0);
        } else {
            app.relaunch();
            app.exit(0);
        }
    });

    ipcMain.on('global-media-keys-enable', () => {
        enableMediaKeys(mainWindow);
    });

    ipcMain.on('global-media-keys-disable', () => {
        disableMediaKeys();
    });

    ipcMain.on('download-url', (_event, url: string) => {
        mainWindow?.webContents.downloadURL(url);
    });

    const globalMediaKeysEnabled = store.get('global_media_hotkeys', true) as boolean;

    if (globalMediaKeysEnabled) {
        enableMediaKeys(mainWindow);
    }

    const startWindowMinimized = store.get('window_start_minimized', false) as boolean;

    mainWindow.on('ready-to-show', () => {
        // mainWindow.show()

        if (!mainWindow) {
            throw new Error('"mainWindow" is not defined');
        }

        if (!first || !startWindowMinimized) {
            const maximized = store.get('maximized');
            const fullScreen = store.get('fullscreen');

            if (maximized) {
                mainWindow.maximize();
            }
            if (fullScreen) {
                mainWindow.setFullScreen(true);
            }

            mainWindow.show();
            createWinThumbarButtons();
        }

        // Window is on screen; pull the non-critical IPC feature handlers
        // (Discord RPC, autodiscover, peer-broker, native TCP socket) in now
        // that they are off the boot critical path. Their handlers are still
        // registered long before any renderer IPC can reach them.
        loadDeferredCoreFeatures();

        // Kick off the auto-update check only after the window is painted.
        // `new AppUpdater()` issues network requests (checkForUpdates /
        // checkForUpdatesAndNotify) that have nothing to do with first paint,
        // so running them here keeps the cold-start critical path free of an
        // outbound HTTP round-trip. Guarded so it fires at most once per
        // window and respects the same disable flags as before.
        if (
            first &&
            !appUpdaterStarted &&
            !disableAutoUpdates() &&
            store.get('disable_auto_updates') !== true
        ) {
            appUpdaterStarted = true;
            console.info('[startup] ready-to-show: starting AppUpdater check');
            new AppUpdater();
        }

        log.info('Main window created', { startMinimized: startWindowMinimized && first });
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        log.error('Renderer process gone', {
            exitCode: details.exitCode,
            reason: details.reason,
        });
    });

    mainWindow.webContents.on('unresponsive', () => {
        log.error('Renderer process unresponsive');
    });

    mainWindow.on('swipe', (_event, direction) => {
        if (direction === 'right' && mainWindow?.webContents.navigationHistory.canGoForward()) {
            mainWindow.webContents.navigationHistory.goForward();
        } else if (direction === 'left' && mainWindow?.webContents.navigationHistory.canGoBack()) {
            mainWindow.webContents.navigationHistory.goBack();
        }
    });

    mainWindow.on('closed', () => {
        log.info('Main window closed');
        ipcMain.removeHandler('window-clear-cache');
        // createWindow() registers these ipcMain.on listeners and the local
        // shortcut on every invocation (macOS re-activate, tray "open main
        // window"). Without tearing them down on close they accumulate, so a
        // single renderer IPC fires its handler N times after a reopen —
        // download-url downloads N times, app-restart relaunches repeatedly,
        // window-quit calls app.exit() N times. Each channel is registered ONLY
        // here, so removeAllListeners targets exactly our listener.
        for (const channel of [
            'window-maximize',
            'window-unmaximize',
            'window-minimize',
            'window-close',
            'window-quit',
            'app-restart',
            'global-media-keys-enable',
            'global-media-keys-disable',
            'download-url',
            'window-dev-tools',
            'sync-progress',
        ]) {
            ipcMain.removeAllListeners(channel);
        }
        if (mainWindow) electronLocalShortcut.unregisterAll(mainWindow);
        mainWindow = null;
    });

    mainWindow.on('close', (event) => {
        if (mainWindow) {
            const bounds = mainWindow.getNormalBounds();
            store.set(
                'bounds',
                clampWindowBoundsToDisplay(bounds, screen.getDisplayMatching(bounds).workArea),
            );
            store.set('maximized', mainWindow.isMaximized());
            store.set('fullscreen', mainWindow.isFullScreen());
        }

        if (!exitFromTray && store.get('window_exit_to_tray')) {
            event.preventDefault();
            log.info('Main window hidden to tray');
            hideMainWindowToTray();
        }

        if (forceQuit) {
            log.info('App quitting', { reason: 'forceQuit' });
            app.exit();
        }
    });

    mainWindow.on('minimize', () => {
        if (store.get('window_minimize_to_tray') === true) {
            log.info('Main window minimized to tray');
            setImmediate(() => {
                hideMainWindowToTray();
            });
        }
    });

    if (isWindows()) {
        app.setAppUserModelId('org.jeffvli.feishin');
    }

    menuBuilder = new MenuBuilder(getMainWindow, showMainWindow);
    rebuildMainMenu();

    // Open URLs in the user's browser
    mainWindow.webContents.setWindowOpenHandler((edata) => {
        if (validateUrl(edata.url)) {
            shell.openExternal(edata.url);
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
        if (!canHandleVisualizerDisplayMedia()) {
            callback({});
            return;
        }

        if (!isMacOS()) {
            callback({ audio: 'loopback' });
            return;
        }

        desktopCapturer
            .getSources({ thumbnailSize: { height: 0, width: 0 }, types: ['screen'] })
            .then((sources) => {
                const source = sources[0];
                if (!source) {
                    callback({});
                    return;
                }

                callback({ audio: 'loopback', video: source });
            })
            .catch((err) => {
                log.warn('desktopCapturer.getSources failed', err);
                callback({});
            });
    });

    const theme = store.get('theme') as TitleTheme | undefined;
    nativeTheme.themeSource = theme || 'dark';

    // (setWindowOpenHandler is registered once above — Electron keeps only the
    // last handler, so a second identical registration here was dead code.)

    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
}

// Only allow hardware media key handling if:
// 1. The "Enable Media Session" setting is enabled
// 2. The playback type is WEB (mpv not supported)
// 3. The platform is not Linux (because we are using mpris instead)
const enableMediaSession = store.get('mediaSession', false) as boolean;
const playbackType = store.get('playbackType', PlayerType.WEB) as PlayerType;
const shouldDisableMediaFeatures =
    isLinux() || !enableMediaSession || playbackType !== PlayerType.WEB;

const chromiumDisabledFeatures: string[] = [];
// Fractional scaling on Wayland: https://github.com/jeffvli/feishin/issues/1271#issuecomment-4063326712
if (isLinux()) {
    chromiumDisabledFeatures.push('WaylandFractionalScaleV1');
}
if (shouldDisableMediaFeatures) {
    chromiumDisabledFeatures.push('HardwareMediaKeyHandling', 'MediaSessionService');
}

if (chromiumDisabledFeatures.length > 0) {
    app.commandLine.appendSwitch('disable-features', chromiumDisabledFeatures.join(','));
}

// https://github.com/electron/electron/issues/46538#issuecomment-2808806722
app.commandLine.appendSwitch('gtk-version', '3');

// Enable garbage collection API
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// Must duplicate with the one in renderer process settings.store.ts
enum BindingActions {
    GLOBAL_SEARCH = 'globalSearch',
    MUTE = 'volumeMute',
    NEXT = 'next',
    NEXT_ALBUM = 'nextAlbum',
    PAUSE = 'pause',
    PLAY = 'play',
    PLAY_PAUSE = 'playPause',
    PREVIOUS = 'previous',
    PREVIOUS_ALBUM = 'previousAlbum',
    SHUFFLE = 'toggleShuffle',
    SKIP_BACKWARD = 'skipBackward',
    SKIP_FORWARD = 'skipForward',
    STOP = 'stop',
    TOGGLE_REPEAT = 'toggleRepeat',
    VOLUME_DOWN = 'volumeDown',
    VOLUME_UP = 'volumeUp',
}

const getMenuAccelerator = (
    data: Record<BindingActions, { allowGlobal: boolean; hotkey: string; isGlobal: boolean }>,
    action: BindingActions,
) => {
    const hotkey = data[action]?.hotkey;

    if (!hotkey) return undefined;

    return hotkeyToElectronAccelerator(hotkey);
};

// Renderer channel each global hotkey triggers. Bindings without one (e.g.
// search, queue, fullscreen player) are in-app only.
const HOTKEY_CHANNELS: Partial<Record<BindingActions, string>> = {
    [BindingActions.MUTE]: 'renderer-player-volume-mute',
    [BindingActions.NEXT]: 'renderer-player-next',
    [BindingActions.NEXT_ALBUM]: 'renderer-player-next-album',
    [BindingActions.PAUSE]: 'renderer-player-pause',
    [BindingActions.PLAY]: 'renderer-player-play',
    [BindingActions.PLAY_PAUSE]: 'renderer-player-play-pause',
    [BindingActions.PREVIOUS]: 'renderer-player-previous',
    [BindingActions.PREVIOUS_ALBUM]: 'renderer-player-previous-album',
    [BindingActions.SHUFFLE]: 'renderer-player-toggle-shuffle',
    [BindingActions.SKIP_BACKWARD]: 'renderer-player-skip-backward',
    [BindingActions.SKIP_FORWARD]: 'renderer-player-skip-forward',
    [BindingActions.STOP]: 'renderer-player-stop',
    [BindingActions.TOGGLE_REPEAT]: 'renderer-player-toggle-repeat',
    [BindingActions.VOLUME_DOWN]: 'renderer-player-volume-down',
    [BindingActions.VOLUME_UP]: 'renderer-player-volume-up',
};

ipcMain.on(
    'set-global-shortcuts',
    (
        _event,
        data: Record<BindingActions, { allowGlobal: boolean; hotkey: string; isGlobal: boolean }>,
    ) => {
        // Since we're not tracking the previous shortcuts, we need to unregister all of them
        globalShortcut.unregisterAll();

        for (const [action, { hotkey, isGlobal }] of Object.entries(data)) {
            if (!isGlobal || !hotkey) continue;

            const channel = HOTKEY_CHANNELS[action as BindingActions];
            const accelerator = hotkeyToElectronAccelerator(hotkey);
            try {
                // Throws on an accelerator Electron can't parse; that must not
                // abort registering the remaining shortcuts.
                globalShortcut.register(accelerator, () => {
                    if (channel) getMainWindow()?.webContents.send(channel);
                });
            } catch (error) {
                log.warn('Failed to register global shortcut', { accelerator, action, error });
            }
        }

        menuState.accelerators = {
            globalSearch: getMenuAccelerator(data, BindingActions.GLOBAL_SEARCH),
            next: getMenuAccelerator(data, BindingActions.NEXT),
            pause: getMenuAccelerator(data, BindingActions.PAUSE),
            play: getMenuAccelerator(data, BindingActions.PLAY),
            playPause: getMenuAccelerator(data, BindingActions.PLAY_PAUSE),
            previous: getMenuAccelerator(data, BindingActions.PREVIOUS),
            repeat: getMenuAccelerator(data, BindingActions.TOGGLE_REPEAT),
            seekBackward: getMenuAccelerator(data, BindingActions.SKIP_BACKWARD),
            seekForward: getMenuAccelerator(data, BindingActions.SKIP_FORWARD),
            shuffle: getMenuAccelerator(data, BindingActions.SHUFFLE),
            stop: getMenuAccelerator(data, BindingActions.STOP),
            volumeDown: getMenuAccelerator(data, BindingActions.VOLUME_DOWN),
            volumeUp: getMenuAccelerator(data, BindingActions.VOLUME_UP),
        };

        if (isMacOS()) {
            rebuildMainMenu();
        }

        const globalMediaKeysEnabled = store.get('global_media_hotkeys', true) as boolean;

        if (globalMediaKeysEnabled) {
            enableMediaKeys(mainWindow);
        }
    },
);

ipcMain.handle('power-save-blocker-start', (_event, { full }: { full: boolean }) => {
    if (powerSaveBlockerId !== null) {
        return powerSaveBlockerId;
    }

    powerSaveBlockerId = powerSaveBlocker.start(
        full ? 'prevent-display-sleep' : 'prevent-app-suspension',
    );
    return powerSaveBlockerId;
});

ipcMain.handle('power-save-blocker-stop', () => {
    if (powerSaveBlockerId !== null) {
        const stopped = powerSaveBlocker.stop(powerSaveBlockerId);
        powerSaveBlockerId = null;
        return stopped;
    }
    return false;
});

app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    // Respect the OSX convention of having the application in memory even
    // after all windows have been closed
    if (isMacOS()) {
        mainWindow = null;
    } else {
        app.quit();
    }
});

const FONT_HEADERS = new Set([
    'font/collection',
    'font/otf',
    'font/sfnt',
    'font/ttf',
    'font/woff',
    'font/woff2',
]);

const bytesToInt = (array: Uint8Array, length: number): number => {
    let value = 0;
    for (let i = 0; i < length; i++) {
        value = (value << 8) + array[i];
    }

    return value;
};

const FONT_FOUR_BYTE_MAGIC_NUMBERS = new Set([
    0x4f54544f, // font/otf
    0x774f4632, // font/woff2
    0x774f4646, // font/woff
]);

const FONT_FIVE_BYTE_MAGIC_NUMBERS = new Set([
    0x0001000000, // ttf, collection, sfnt
]);

const singleInstance = isDevelopment ? true : app.requestSingleInstanceLock();

if (!singleInstance) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            showMainWindow();
        }
    });

    app.whenReady()
        .then(() => {
            log.info('App ready', {
                arch: process.arch,
                electron: process.versions.electron,
                ignoreCors: !!store.get('ignore_cors'),
                ignoreSsl: !!store.get('ignore_ssl'),
                platform: process.platform,
                version: packageJson.version,
            });

            protocol.handle('feishin', async () => {
                const filePath = store.get('local_font_path');
                if (typeof filePath !== 'string') {
                    getMainWindow()?.webContents.send('custom-font-error', filePath);

                    return new Response(null, {
                        status: 403,
                        statusText: 'Forbidden',
                    });
                }

                const response = await net.fetch('file:' + filePath);
                const contentType = response.headers.get('content-type');

                // On Linux, the mime type is included in the response header
                // In this case, we can forward the response with no further processing
                if (contentType && FONT_HEADERS.has(contentType)) {
                    return response;
                }

                // Otherwise, let's check the magic number to see if
                // the file is a font type. This is either four or five bytes
                const payload = await response.arrayBuffer();
                const magicNumber = new Uint8Array(payload.slice(0, 5));
                const fiveHex = bytesToInt(magicNumber, 5);
                const fourHex = bytesToInt(magicNumber, 4);

                if (
                    FONT_FIVE_BYTE_MAGIC_NUMBERS.has(fiveHex) ||
                    FONT_FOUR_BYTE_MAGIC_NUMBERS.has(fourHex)
                ) {
                    // We have to create a new response with the payload, since it has been read now
                    return new Response(payload, {
                        headers: response.headers,
                    });
                }

                getMainWindow()?.webContents.send('custom-font-error', filePath);

                return new Response(null, {
                    status: 403,
                    statusText: 'Forbidden',
                });
            });

            // Chromium 43 enforces Local Network Access: a request from the file:// renderer
            // to a private address needs this permission, which is denied without a handler,
            // so a server on a LAN address cannot be reached at all (jeffvli/feishin#2430).
            const ALLOWED_PERMISSIONS = new Set([
                'local-fonts',
                'local-network',
                'local-network-access',
                'loopback-network',
            ]);
            session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
                ALLOWED_PERMISSIONS.has(permission),
            );
            session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
                callback(ALLOWED_PERMISSIONS.has(permission)),
            );

            session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
                callback({
                    responseHeaders: {
                        ...details.responseHeaders,
                        // 'unsafe-eval' is required by the butterchurn music
                        // visualizer, which compiles Milkdrop preset equations
                        // at runtime via `new Function()`. 'wasm-unsafe-eval'
                        // covers its WebAssembly compilation. Without these the
                        // CSP blocks preset compilation and the visualizer fails
                        // to load on desktop (Electron is the only platform that
                        // applies this header).
                        'Content-Security-Policy': [
                            "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; media-src 'self' http: https: data: blob:; img-src 'self' http: https: data: blob:; connect-src 'self' http: https: ws: wss:; default-src 'self';",
                        ],
                    },
                });
            });

            createWindow();
            if (store.get('window_enable_tray', true)) {
                createTray();
            }
            app.on('activate', () => {
                // On macOS it's common to re-create a window in the app when the
                // dock icon is clicked and there are no other windows open.
                if (mainWindow === null) createWindow(false);
                else if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
                    showMainWindow();
                }
            });
        })
        .catch((error) => log.error(error));
}

ipcMain.handle('open-item', async (_event, path: string) => {
    await access(path, constants.F_OK);
    shell.showItemInFolder(path);
});

ipcMain.handle('open-application-directory', async () => {
    shell.openPath(app.getPath('userData'));
});

const MENU_STATE_CHANNELS = {
    'update-playback': 'playbackStatus',
    'update-private-mode': 'privateMode',
    'update-repeat': 'repeatMode',
    'update-shuffle': 'shuffleEnabled',
    'update-sidebar-collapsed': 'sidebarCollapsed',
} as const;

for (const [channel, key] of Object.entries(MENU_STATE_CHANNELS)) {
    ipcMain.on(channel, (_event, value) => {
        menuState[key] = value;
        if (isMacOS()) updateMainMenu();
    });
}
