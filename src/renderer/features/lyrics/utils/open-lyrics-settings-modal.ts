import { openContextModal } from '@mantine/modals';

import i18n from '/@/i18n/i18n';
import { MOBILE_SHELL_QUERY } from '/@/renderer/hooks/use-breakpoint';

/**
 * Returns true when the current viewport should render the lyrics settings
 * as a full-screen sheet rather than a centred floating modal.
 *
 * Mirrors `openVisualizerSettingsModal`'s `shouldRenderFullScreen` (and the
 * shared `MOBILE_SHELL_QUERY`) so the two config surfaces behave identically
 * on a phone. Evaluated at open-time (not via a hook) because this is a
 * fire-and-forget util called from the lyrics gear handler.
 */
const shouldRenderFullScreen = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_SHELL_QUERY).matches;
};

export const openLyricsSettingsModal = (settingsKey: string = 'default') => {
    const fullScreen = shouldRenderFullScreen();

    openContextModal({
        fullScreen,
        innerProps: { settingsKey },
        modal: 'lyricsSettings',
        overlayProps: {
            blur: 0,
            opacity: 0,
        },
        size: fullScreen ? '100%' : 'xl',
        styles: {
            // On the mobile shell let the dense settings form scroll within
            // the sheet rather than overflowing the page.
            body: fullScreen
                ? {
                      height: 'calc(100dvh - 60px)',
                      overflowY: 'auto',
                      padding: 'var(--theme-spacing-sm)',
                  }
                : undefined,
            content: fullScreen
                ? {
                      // 100dvh tracks the dynamic viewport so the sheet
                      // doesn't overshoot when mobile browsers show their
                      // URL bar. maxWidth:100vw keeps the SegmentedControl
                      // (Left / Center / Right) from clipping off the edges.
                      height: '100dvh',
                      maxHeight: '100dvh',
                      maxWidth: '100vw',
                      width: '100vw',
                  }
                : {
                      height: '90%',
                      maxWidth: '1400px',
                      minHeight: '600px',
                      width: '100%',
                  },
            // The lyrics modal can be opened from the fullscreen visualizer
            // (overlay z-index 200). Without a solid background the still
            // running visualizer paints through and the settings become
            // illegible; the header gets its own background + safe-area top
            // pad so the close X clears the status-bar / notch.
            header: fullScreen
                ? {
                      background: 'var(--theme-colors-background)',
                      borderBottom: '1px solid var(--theme-colors-border)',
                      paddingBottom: 'var(--theme-spacing-sm)',
                      paddingLeft: 'var(--theme-spacing-sm)',
                      paddingRight: 'var(--theme-spacing-sm)',
                      paddingTop:
                          'calc(var(--theme-spacing-sm) + max(env(safe-area-inset-top, 0px), var(--android-safe-top, 0px)))',
                  }
                : undefined,
            inner: fullScreen
                ? {
                      background: 'var(--theme-colors-background)',
                  }
                : undefined,
        },
        title: i18n.t('common.setting', { count: 2 }),
        transitionProps: {
            transition: 'pop',
        },
        // Render above the fullscreen visualizer/player overlays (z-index
        // 200). Without this the modal portal ties on z-index and the
        // later-painted visualizer overlay wins, leaving the config UI dead
        // behind the visualizer.
        zIndex: 250,
    });
};
