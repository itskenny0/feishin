import { t } from 'i18next';
import { motion, Variants } from 'motion/react';
import { lazy, memo, ReactNode, Suspense, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import styles from './full-screen-visualizer.module.css';

import { Lyrics } from '/@/renderer/features/lyrics/lyrics';
import { FullScreenVisualizerSongInfo } from '/@/renderer/features/player/components/full-screen-visualizer-song-info';
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
    closed: (custom) => {
        const { isMobile, windowBarStyle } = custom;
        if (isMobile) {
            /*
             * Truly full-viewport on phones. The visualizer is mounted
             * inside `.fullScreenPlayerOverlay` (position: fixed inset:
             * 0, z-index: 200) so taking 100dvh here covers the
             * bottom-tab-bar + mini-player completely. The previous
             * `calc(100vh - 120px)` left a strip at the bottom where
             * the tab-bar bled through but couldn't be interacted with.
             */
            return {
                height: '100dvh',
                position: 'absolute',
                top: '100dvh',
                transition: {
                    duration: 0.5,
                    ease: 'easeInOut',
                },
                width: '100vw',
                y: 0,
            };
        }
        const height =
            windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS
                ? 'calc(100vh - 120px)'
                : 'calc(100vh - 90px)';
        return {
            height,
            position: 'absolute',
            top: '100vh',
            transition: {
                duration: 0.5,
                ease: 'easeInOut',
            },
            width: '100vw',
            y: 0,
        };
    },
    open: (custom) => {
        const { isMobile, windowBarStyle } = custom;
        if (isMobile) {
            return {
                height: '100dvh',
                left: 0,
                position: 'absolute',
                top: 0,
                transition: {
                    delay: 0.1,
                    duration: 0.5,
                    ease: 'easeInOut',
                },
                width: '100vw',
                y: 0,
            };
        }
        const height =
            windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS
                ? 'calc(100vh - 120px)'
                : 'calc(100vh - 90px)';
        return {
            height,
            left: 0,
            position: 'absolute',
            top: 0,
            transition: {
                delay: 0.1,
                duration: 0.5,
                ease: 'easeInOut',
            },
            width: '100vw',
            y: 0,
        };
    },
};

interface VisualizerContainerProps {
    children: ReactNode;
    isMobile?: boolean;
    windowBarStyle: Platform;
}

const VisualizerContainer = memo(
    ({ children, isMobile, windowBarStyle }: VisualizerContainerProps) => {
        return (
            <motion.div
                animate="open"
                className={styles.container}
                custom={{ isMobile, windowBarStyle }}
                exit="closed"
                initial="closed"
                transition={{ duration: 2 }}
                variants={containerVariants}
            >
                {children}
            </motion.div>
        );
    },
);

VisualizerContainer.displayName = 'VisualizerContainer';

export const FullScreenVisualizer = () => {
    const { setStore } = useFullScreenPlayerStoreActions();
    const { windowBarStyle } = useWindowSettings();
    const { webAudio } = usePlaybackSettings();
    const visualizerType = useSettingsStore((store) => store.visualizer.type);
    const visualizerLyricsOverlay = useFullScreenPlayerStore(
        (state) => state.visualizerLyricsOverlay,
    );
    const isMobile = useIsMobile();

    const location = useLocation();
    const isOpenedRef = useRef<boolean | null>(null);

    const handleCloseVisualizer = () => {
        setStore({ visualizerExpanded: false });
    };

    useHotkeys([['Escape', handleCloseVisualizer]]);

    useLayoutEffect(() => {
        if (isOpenedRef.current !== null) {
            setStore({ visualizerExpanded: false });
        }

        isOpenedRef.current = true;
    }, [location, setStore]);

    return (
        <VisualizerContainer isMobile={isMobile} windowBarStyle={windowBarStyle}>
            {/*
             * Floating close button. Without this the visualizer overlay
             * had no visible dismiss affordance on mobile (only Escape
             * worked, which requires a keyboard). Positioned via CSS in
             * the top-right with safe-area-top respected so it doesn't
             * sit under the Android status-bar clock.
             */}
            <ActionIcon
                aria-label={t('common.close', { defaultValue: 'Close' })}
                className={styles.closeButton}
                icon="x"
                iconProps={{ size: 'xl' }}
                onClick={handleCloseVisualizer}
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
                className={styles.lyricsToggleButton}
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
            <div className={styles.visualizerContainer}>
                {webAudio ? (
                    <Suspense fallback={<></>}>
                        {visualizerType === 'butterchurn' ? (
                            <ButterchurnVisualizer />
                        ) : (
                            <AudioMotionAnalyzerVisualizer />
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
