import { Capacitor } from '@capacitor/core';
import clsx from 'clsx';

import styles from './player-bar.module.css';

import { RemoteStatusBanner } from '/@/renderer/features/jellyfin-remote-target/components/remote-status-banner';
import { Playerbar } from '/@/renderer/features/player/components/playerbar';
import { useIsMobile } from '/@/renderer/hooks/use-is-mobile';
import { useSoftKeyboardVisible } from '/@/renderer/hooks/use-soft-keyboard-visible';
import { usePlayerbarOpenDrawer } from '/@/renderer/store';

// Touch / native contexts where a soft keyboard can appear. Excludes a plain
// desktop browser window (whose resize would otherwise also shrink the visual
// viewport and wrongly hide the bar). `maxTouchPoints` catches mobile web /
// PWA; `isNativePlatform` catches the Capacitor Android / iOS shells.
export const isTouchOrNative = (): boolean => {
    if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true;
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

export const PlayerBar = () => {
    const playerbarOpenDrawer = usePlayerbarOpenDrawer();
    // Only the mobile shell floats the mini-player above the soft keyboard.
    // Pair the mobile-shell check with a touch/native gate so a desktop
    // window resize never trips the visual-viewport heuristic.
    const isMobile = useIsMobile();
    const keyboardVisible = useSoftKeyboardVisible({ enabled: isMobile && isTouchOrNative() });

    return (
        <div
            className={clsx({
                [styles.container]: true,
                [styles.keyboardHidden]: keyboardVisible,
                [styles.openDrawer]: playerbarOpenDrawer,
            })}
            id="player-bar"
        >
            <RemoteStatusBanner />
            <Playerbar />
        </div>
    );
};
