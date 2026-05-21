/* eslint-disable perfectionist/sort-imports */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import 'overlayscrollbars/overlayscrollbars.css';
import '/styles/overlayscrollbars.css';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import isElectron from 'is-electron';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import i18n from '/@/i18n/i18n';
import { WebAudioContext } from '/@/renderer/features/player/context/webaudio-context';
import { useDocumentTitle } from '/@/renderer/features/shared/hooks/use-document-title';
import {
    useAndroidBackButton,
    useAndroidKeepAwake,
    useAndroidStatusBar,
} from '/@/renderer/hooks/use-android-native';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useCheckForUpdates } from '/@/renderer/hooks/use-check-for-updates';
import { useGithubReleasesUpdater } from '/@/renderer/hooks/use-github-releases-updater';
import { useNativeMenuSync } from '/@/renderer/hooks/use-native-menu-sync';
import { useSyncSettingsToMain } from '/@/renderer/hooks/use-sync-settings-to-main';
import { AppRouter } from '/@/renderer/router/app-router';
import { useCssSettings, useHotkeySettings, useLanguage } from '/@/renderer/store';
import { useAppTheme } from '/@/renderer/themes/use-app-theme';
import { sanitizeCss } from '/@/renderer/utils/sanitize';
import { WebAudio } from '/@/shared/types/types';
import '/@/shared/styles/global.css';
import { PlayerProvider } from '/@/renderer/features/player/context/player-context';
import { AudioPlayers } from '/@/renderer/features/player/components/audio-players';

const UpdateAvailableDialog = lazy(() =>
    import('./update-available-dialog').then((module) => ({
        default: module.UpdateAvailableDialog,
    })),
);

const ipc = isElectron() ? window.api.ipc : null;

export const App = () => {
    return <ThemedApp />;
};

const ThemedApp = () => {
    const { mode, theme } = useAppTheme();

    return (
        <MantineProvider forceColorScheme={mode} theme={theme}>
            <AppShell />
        </MantineProvider>
    );
};

const AppShell = memo(function AppShell() {
    const [webAudio, setWebAudio] = useState<WebAudio>();

    const webAudioProvider = useMemo(() => {
        return { setWebAudio, webAudio };
    }, [webAudio]);

    // Bottom margin on bottom-centered toasts needs to clear whatever
    // chrome sits at the bottom of the viewport:
    //  - desktop shell: just the playerbar (90px)
    //  - mobile shell:  playerbar (90px) + tab bar (56px) + safe-area
    // We also pad an extra safe-area-inset-bottom via env() so the toast
    // always sits above the device's gesture pill on Capacitor Android.
    const isMobileShell = useIsMobileShell();
    const notificationStyles = useMemo(
        () => ({
            root: {
                marginBottom: isMobileShell
                    ? 'calc(90px + 56px + env(safe-area-inset-bottom, 0px) + 12px)'
                    : 'calc(90px + env(safe-area-inset-bottom, 0px))',
            },
        }),
        [isMobileShell],
    );

    return (
        <>
            <AppEffects />
            <Notifications
                containerWidth="300px"
                position="bottom-center"
                styles={notificationStyles}
                zIndex={50000}
            />
            <WebAudioContext.Provider value={webAudioProvider}>
                <PlayerProvider>
                    <AudioPlayers />
                    <AppRouter />
                </PlayerProvider>
            </WebAudioContext.Provider>
            <Suspense fallback={null}>
                <UpdateAvailableDialog />
            </Suspense>
        </>
    );
});

const AppEffects = () => (
    <>
        <SyncSettingsEffect />
        <UpdateCheckEffect />
        <CssSettingsEffect />
        <GlobalShortcutsEffect />
        <LanguageEffect />
        <NativeMenuSyncEffect />
        <DocumentTitleEffect />
        <AndroidNativeEffect />
    </>
);

const AndroidNativeEffect = () => {
    useAndroidStatusBar();
    useAndroidBackButton();
    useAndroidKeepAwake();

    return null;
};

const DocumentTitleEffect = () => {
    useDocumentTitle();

    return null;
};

const SyncSettingsEffect = () => {
    useSyncSettingsToMain();

    return null;
};

const UpdateCheckEffect = () => {
    // Electron path — points at the fork's release feed.
    useCheckForUpdates();
    // Web + Capacitor Android path — polls GitHub releases directly and
    // surfaces a toast when a newer build is published. No-ops in Electron.
    useGithubReleasesUpdater();

    return null;
};

const CssSettingsEffect = () => {
    const { content, enabled } = useCssSettings();
    const cssRef = useRef<HTMLStyleElement | null>(null);

    useEffect(() => {
        if (!enabled || !content) {
            if (cssRef.current) {
                cssRef.current.textContent = '';
            }

            return;
        }

        // Yes, CSS is sanitized here as well. Prevent a user from changing the
        // localStorage to bypass sanitizing.
        const sanitized = sanitizeCss(content);
        if (!cssRef.current) {
            cssRef.current = document.createElement('style');
            document.body.appendChild(cssRef.current);
        }

        cssRef.current.textContent = sanitized;

        return () => {
            if (cssRef.current) {
                cssRef.current.textContent = '';
            }
        };
    }, [content, enabled]);

    return null;
};

const GlobalShortcutsEffect = () => {
    const { bindings } = useHotkeySettings();

    useEffect(() => {
        if (isElectron()) {
            ipc?.send('set-global-shortcuts', bindings);
        }
    }, [bindings]);

    return null;
};

const LanguageEffect = () => {
    const language = useLanguage();

    useEffect(() => {
        if (language) {
            i18n.changeLanguage(language);
        }
    }, [language]);

    return null;
};

const NativeMenuSyncEffect = () => {
    useNativeMenuSync();

    return null;
};
