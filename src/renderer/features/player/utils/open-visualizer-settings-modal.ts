import { openContextModal } from '@mantine/modals';

import i18n from '/@/i18n/i18n';

/**
 * Returns true when the current viewport should render the visualizer
 * settings as a full-screen sheet rather than a centred floating modal.
 *
 * Mirrors the `MOBILE_SHELL_QUERY` in `/@/renderer/hooks/use-breakpoint` so
 * the modal sizing matches the rest of the mobile shell — a phone in either
 * orientation gets a full-screen sheet, everything else gets the desktop
 * modal. We evaluate the query at open-time (not via a hook) because this
 * is a fire-and-forget util called from the playerbar/fullscreen-visualizer
 * action handlers.
 */
const shouldRenderFullScreen = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 767px), (orientation: landscape) and (max-height: 480px)')
        .matches;
};

export const openVisualizerSettingsModal = () => {
    const fullScreen = shouldRenderFullScreen();

    openContextModal({
        fullScreen,
        innerProps: {},
        modal: 'visualizerSettings',
        overlayProps: {
            blur: 0,
            opacity: 0,
        },
        // On the mobile shell the inner form is dense (many fieldsets each
        // with horizontal Groups of buttons + sliders). Skip the modal's
        // own scroll cap so we never end up with a non-scrollable column
        // taller than the viewport.
        size: fullScreen ? '100%' : 'xl',
        styles: {
            // On mobile, let the form fill the sheet edge-to-edge — the
            // CSS inside visualizer-settings-form.module.css adds its
            // own gutters tuned for narrow screens.
            body: fullScreen
                ? {
                      // Full available height minus the header row so the
                      // form can scroll within the sheet without the
                      // page itself scrolling.
                      height: 'calc(100dvh - 60px)',
                      overflowY: 'auto',
                      padding: 'var(--theme-spacing-sm)',
                  }
                : undefined,
            content: fullScreen
                ? {
                      // 100dvh follows the dynamic viewport so the modal
                      // doesn't overshoot the visible area when iOS Safari
                      // / Chrome show their URL bar.
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
            // Without an explicit dark backdrop on mobile, the still-running
            // fullscreen visualizer paints through the transparent overlay
            // and turns the form into illegible white-on-rainbow. The
            // header gets its own subtle background so the close X has a
            // hit area that's distinguishable from the visualization. Top
            // padding lifts past the status-bar / notch — env() covers
            // iOS, --android-safe-top is the Capacitor Android fallback.
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
            // On mobile, paint a solid background so the form is readable
            // against the still-running visualizer that lives behind the
            // modal (overlayProps is opacity:0 by design so the user can
            // see their settings reflected live in the visualization).
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
    });
};
