import { t } from 'i18next';
import { motion, Variants } from 'motion/react';
import { lazy, memo, ReactNode, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import styles from './full-screen-visualizer.module.css';

import { Lyrics } from '/@/renderer/features/lyrics/lyrics';
import { FullScreenVisualizerSongInfo } from '/@/renderer/features/player/components/full-screen-visualizer-song-info';
import { useIdleControls } from '/@/renderer/features/player/hooks/use-idle-controls';
import { openVisualizerSettingsModal } from '/@/renderer/features/player/utils/open-visualizer-settings-modal';
import { VISUALIZER_FULLSCREEN_TARGET_ID } from '/@/renderer/hooks/use-fullscreen-toggle';
import { useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { useIsMobile } from '/@/renderer/hooks/use-is-mobile';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import {
    usePlaybackSettings,
    useSettingsStore,
    useWindowSettings,
} from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Platform } from '/@/shared/types/types';

const AudioMotionAnalyzerVisualizer = lazy(() =>
    import('../../visualizer/components/audiomotionanalyzer/visualizer').then((module) => ({
        default: module.Visualizer,
    })),
);

const ButterchurnVisualizer = lazy(() =>
    import('../../visualizer/components/butternchurn/visualizer').then((module) => ({
        default: module.Visualizer,
    })),
);

const containerVariants: Variants = {
    closed: {
        transition: {
            duration: 0.5,
            ease: 'easeInOut',
        },
        y: '100%',
    },
    open: {
        transition: {
            delay: 0.1,
            duration: 0.5,
            ease: 'easeInOut',
        },
        y: 0,
    },
};

interface VisualizerContainerProps {
    children: ReactNode;
    isMobile?: boolean;
    onActivity: () => void;
    windowBarStyle: Platform;
}

const VisualizerContainer = memo(({ children, onActivity }: VisualizerContainerProps) => {
    return (
        <motion.div
            animate="open"
            // Fork: no mobile row-pinning classes - on the mobile shell the
            // container fills its full-viewport overlay (covers the tab bar).
            className={styles.container}
            exit="closed"
            initial="closed"
            onMouseMove={onActivity}
            onPointerDown={onActivity}
            onTouchStart={onActivity}
            transition={{ duration: 2 }}
            variants={containerVariants}
        >
            {children}
        </motion.div>
    );
});

VisualizerContainer.displayName = 'VisualizerContainer';

export const FullScreenVisualizer = () => {
    const { setStore } = useFullScreenPlayerStoreActions();
    const { visualizerReturnToPlayer } = useFullScreenPlayerStore();
    const { windowBarStyle } = useWindowSettings();
    const { webAudio } = usePlaybackSettings();
    const visualizerType = useSettingsStore((store) => store.visualizer.type);
    const visualizerLyricsOverlay = useFullScreenPlayerStore(
        (state) => state.visualizerLyricsOverlay,
    );
    const isMobile = useIsMobile();

    const location = useLocation();
    const isOpenedRef = useRef<boolean | null>(null);

    // Idle auto-hide for the top controls (close + lyrics toggle). The
    // visualizer is a lean-back, full-bleed view; persistent buttons clutter
    // it. Fade them out after a few idle seconds and reveal on any pointer /
    // touch / key activity (shared useIdleControls hook).
    const { controlsVisible, revealControls } = useIdleControls();

    const handleCloseVisualizer = () => {
        // While fullscreen, Escape is the browser's own "leave fullscreen" gesture.
        // Let it drop back to the expanded-but-windowed visualizer instead of closing.
        if (document.fullscreenElement) return;

        setStore({
            expanded: visualizerReturnToPlayer,
            visualizerExpanded: false,
            visualizerReturnToPlayer: false,
        });
    };

    useHotkeys([['Escape', handleCloseVisualizer]]);

    // Never leave the window stuck in fullscreen if the visualizer goes away while
    // fullscreened (route change, close button, etc.).
    useEffect(() => {
        return () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
        };
    }, []);

    useLayoutEffect(() => {
        if (isOpenedRef.current !== null) {
            setStore({ visualizerExpanded: false, visualizerReturnToPlayer: false });
        }

        isOpenedRef.current = true;
    }, [location, setStore]);

    return (
        <VisualizerContainer
            isMobile={isMobile}
            onActivity={revealControls}
            windowBarStyle={windowBarStyle}
        >
            {/*
             * Floating close button. Without this the visualizer overlay
             * had no visible dismiss affordance on mobile (only Escape
             * worked, which requires a keyboard). Positioned via CSS in
             * the top-right with safe-area-top respected so it doesn't
             * sit under the Android status-bar clock. Auto-hides with the
             * other top controls when idle.
             */}
            <ActionIcon
                aria-label={t('common.close', { defaultValue: 'Close' })}
                className={`${styles.closeButton} ${styles.topControl} ${
                    controlsVisible ? '' : styles.topControlHidden
                }`}
                icon="x"
                iconProps={{ size: 'xl' }}
                onClick={handleCloseVisualizer}
                size="lg"
                variant="default"
            />
            {/*
             * Configure-visualizer button. The visualizer components' own
             * built-in settings/expand cluster is suppressed in this overlay
             * (hideTopControls) because it sat behind / collided with the
             * close button. Surface a single settings affordance here in the
             * overlay's own control layer, slotted immediately left of the
             * close button so the two never overlap.
             */}
            <ActionIcon
                aria-label={t('common.settings')}
                className={`${styles.configButton} ${styles.topControl} ${
                    controlsVisible ? '' : styles.topControlHidden
                }`}
                icon="settings2"
                iconProps={{ size: 'xl' }}
                onClick={openVisualizerSettingsModal}
                size="lg"
                variant="default"
            />
            {/*
             * In-line lyrics toggle. The "show lyrics over visualizer"
             * setting was previously buried in the fullscreen-player
             * config popover; surfacing it inside the visualizer itself
             * gives users the same one-tap combined view that desktop's
             * sidebar variant has.
             */}
            <ActionIcon
                aria-label={t('page.fullscreenPlayer.config.visualizerLyricsOverlay', {
                    defaultValue: 'Show lyrics over visualizer',
                })}
                aria-pressed={visualizerLyricsOverlay !== false}
                className={`${styles.lyricsToggleButton} ${styles.topControl} ${
                    controlsVisible ? '' : styles.topControlHidden
                }`}
                icon="microphone"
                iconProps={{
                    fill: visualizerLyricsOverlay !== false ? 'primary' : undefined,
                    size: 'xl',
                }}
                onClick={() =>
                    setStore({ visualizerLyricsOverlay: visualizerLyricsOverlay === false })
                }
                size="lg"
                variant="default"
            />
            <div className={styles.visualizerContainer} id={VISUALIZER_FULLSCREEN_TARGET_ID}>
                {webAudio ? (
                    <Suspense fallback={<></>}>
                        {visualizerType === 'butterchurn' ? (
                            <ButterchurnVisualizer chromeless={!controlsVisible} hideTopControls />
                        ) : (
                            <AudioMotionAnalyzerVisualizer
                                chromeless={!controlsVisible}
                                hideTopControls
                            />
                        )}
                    </Suspense>
                ) : null}
                {visualizerLyricsOverlay !== false ? (
                    <div className={styles.lyricsOverlay}>
                        <Lyrics fadeOutNoLyricsMessage />
                    </div>
                ) : (
                    <FullScreenVisualizerSongInfo />
                )}
            </div>
        </VisualizerContainer>
    );
};
