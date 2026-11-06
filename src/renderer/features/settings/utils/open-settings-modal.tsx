import { openContextModal } from '@mantine/modals';

import { SettingsHeader } from '/@/renderer/features/settings/components/settings-header';
import { MOBILE_SHELL_QUERY } from '/@/renderer/hooks/use-breakpoint';

// Utility module (no React tree), so sample the same query useIsMobileShell()
// uses directly at open-time: phones in either orientation get a fullscreen
// sheet, tablets and desktops the regular sized modal.
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
        title: <SettingsHeader showUpdateAvailable />,
        transitionProps: {
            transition: isMobile ? 'slide-up' : 'pop',
        },
    });
};
