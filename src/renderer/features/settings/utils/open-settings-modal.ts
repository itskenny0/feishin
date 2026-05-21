import { openContextModal } from '@mantine/modals';

/*
 * Mobile-shell query mirrors useIsMobileShell() in
 * /@/renderer/hooks/use-breakpoint. We can't use that hook here
 * (utility module, no React tree), so we sample window.matchMedia
 * directly at open-time. The query catches phones in either
 * orientation; tablets and desktops get the regular sized modal.
 */
const MOBILE_SHELL_QUERY = '(max-width: 767px), (orientation: landscape) and (max-height: 480px)';

export const openSettingsModal = () => {
    const isMobile =
        typeof window !== 'undefined' && window.matchMedia
            ? window.matchMedia(MOBILE_SHELL_QUERY).matches
            : false;

    openContextModal({
        fullScreen: isMobile,
        innerProps: {},
        modal: 'settings',
        overlayProps: {
            opacity: 1,
        },
        size: isMobile ? '100%' : '60rem',
        styles: {
            content: isMobile
                ? {
                      // Full viewport on phones — no centered card, no
                      // 90% width modal. The 100dvh respects the
                      // browser's dynamic viewport so the bottom edge
                      // sits at the actual screen edge (Android's URL
                      // bar collapse, iOS Safari tabs collapse).
                      height: '100dvh',
                      maxWidth: '100%',
                      width: '100%',
                  }
                : {
                      height: '100%',
                      maxWidth: '90%',
                      width: '100%',
                  },
        },
        transitionProps: {
            transition: isMobile ? 'slide-up' : 'pop',
        },
    });
};
