import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './visualizer.module.css';

import { useIdleControls } from '/@/renderer/features/player/hooks/use-idle-controls';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import { getVisualizerAudioNodes } from '/@/renderer/features/player/utils/get-visualizer-audio-nodes';
import { openVisualizerSettingsModal } from '/@/renderer/features/player/utils/open-visualizer-settings-modal';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { usePlaybackType, useSettingsStore } from '/@/renderer/store';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import { usePlayerStatus } from '/@/renderer/store/player.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const VisualizerInner = () => {
    const { webAudio } = useWebAudio();
    // useRef, not createRef — the latter allocates a fresh ref object on every
    // render, which (when the ref is in an effect's deps) causes teardown +
    // re-attach of WebGL contexts on every parent re-render. Same fix the
    // butterchurn visualizer got.
    const canvasRef = useRef<HTMLDivElement | null>(null);
    const visualizer = useSettingsStore((store) => store.visualizer);
    const playbackType = usePlaybackType();
    const opacity = useSettingsStore((store) => store.visualizer.audiomotionanalyzer.opacity);
    const [motion, setMotion] = useState<any>();
    const [libraryLoaded, setLibraryLoaded] = useState(false);
    const AudioMotionAnalyzerRef = useRef<any>(null);
    const pauseTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const playerStatus = usePlayerStatus();
    const isPlaying = playerStatus === PlayerStatus.PLAYING;

    useEffect(() => {
        let isMounted = true;

        const loadLibrary = async () => {
            try {
                const module = await import('audiomotion-analyzer');
                if (isMounted) {
                    AudioMotionAnalyzerRef.current = module.default;
                    setLibraryLoaded(true);
                }
            } catch (error) {
                console.error('Failed to load AudioMotionAnalyzer library:', error);
            }
        };

        loadLibrary();

        return () => {
            isMounted = false;
        };
    }, []);

    // Check if a gradient name is a custom gradient. Keyed on the narrow
    // slices it actually reads (type + customGradients) rather than the whole
    // `visualizer` object, so live tuning of unrelated knobs (barSpace, fftSize,
    // …) doesn't churn this callback's identity and, through it, the options
    // memo + setOptions effect below.
    const isCustomGradient = useCallback(
        (gradientName: string | undefined): boolean => {
            if (!gradientName || visualizer.type !== 'audiomotionanalyzer') {
                return false;
            }

            const customGradients = visualizer.audiomotionanalyzer.customGradients || [];
            return customGradients.some((gradient) => gradient.name === gradientName);
        },
        [visualizer.type, visualizer.audiomotionanalyzer.customGradients],
    );

    const [gradientsRegistered, setGradientsRegistered] = useState(false);

    const options = useMemo(() => {
        if (visualizer.type !== 'audiomotionanalyzer') {
            return {};
        }

        const ama = visualizer.audiomotionanalyzer;

        const defaults = {
            bgAlpha: 0,
            showBgColor: false,
        };

        const gradients: { gradient?: string; gradientLeft?: string; gradientRight?: string } = {};

        // Use default gradient if custom gradient is selected but not yet registered
        const getSafeGradient = (gradientName: string | undefined): string => {
            if (!gradientName) return 'classic';
            if (isCustomGradient(gradientName)) {
                // Use default until custom gradients are registered
                return gradientsRegistered ? gradientName : 'classic';
            }
            return gradientName;
        };

        if (ama.channelLayout === 'single') {
            gradients.gradient = getSafeGradient(ama.gradient);
        } else {
            gradients.gradientLeft = getSafeGradient(ama.gradientLeft);
            gradients.gradientRight = getSafeGradient(ama.gradientRight);
        }

        return {
            ...defaults,
            ...gradients,
            alphaBars: ama.alphaBars,
            ansiBands: ama.ansiBands,
            barSpace: ama.barSpace,
            channelLayout: ama.channelLayout,
            colorMode: ama.colorMode,
            connectSpeakers: false,
            fadePeaks: ama.fadePeaks,
            fftSize: ama.fftSize,
            fillAlpha: ama.fillAlpha,
            frequencyScale: ama.frequencyScale,
            gravity: ama.gravity,
            ledBars: ama.ledBars,
            linearAmplitude: ama.linearAmplitude,
            linearBoost: ama.linearBoost,
            lineWidth: ama.lineWidth,
            loRes: ama.loRes,
            lumiBars: ama.lumiBars,
            maxDecibels: ama.maxDecibels,
            maxFPS: ama.maxFPS,
            maxFreq: ama.maxFreq,
            minDecibels: ama.minDecibels,
            minFreq: ama.minFreq,
            mirror: ama.mirror,
            mode: ama.mode,
            noteLabels: ama.noteLabels,
            outlineBars: ama.outlineBars,
            overlay: true,
            peakFadeTime: ama.peakFadeTime,
            peakHoldTime: ama.peakHoldTime,
            peakLine: ama.peakLine,
            radial: ama.radial,
            radialInvert: ama.radialInvert,
            radius: ama.radius,
            reflexAlpha: ama.reflexAlpha,
            reflexBright: ama.reflexBright,
            reflexFit: ama.reflexFit,
            reflexRatio: ama.reflexRatio,
            roundBars: ama.roundBars,
            showFPS: ama.showFPS,
            showPeaks: ama.showPeaks,
            showScaleX: ama.showScaleX,
            showScaleY: ama.showScaleY,
            smoothing: ama.smoothing,
            spinSpeed: ama.spinSpeed,
            splitGradient: ama.splitGradient,
            trueLeds: ama.trueLeds,
            volume: ama.volume,
            weightingFilter: (ama.weightingFilter || '') as any,
        };
        // Narrowed from the whole `visualizer` object to the two slices read
        // here (type + audiomotionanalyzer) so changes to other visualizer
        // backends' settings don't rebuild this ~60-key object.
    }, [visualizer.type, visualizer.audiomotionanalyzer, gradientsRegistered, isCustomGradient]);

    const transformGradientForVisualizer = useCallback(
        (gradient: {
            colorStops: Array<{
                color: string;
                level?: number;
                levelEnabled?: boolean;
                pos?: number;
                positionEnabled?: boolean;
            }>;
            dir?: string;
        }): {
            colorStops: (string | { color: string; level?: number; pos?: number })[];
            dir?: string;
        } => {
            const transformedColorStops = gradient.colorStops.map((stop) => {
                // If neither position nor level is enabled, return just the color string
                if (!stop.positionEnabled && !stop.levelEnabled) {
                    return stop.color;
                }

                // Otherwise, return an object with only enabled properties
                const transformedStop: { color: string; level?: number; pos?: number } = {
                    color: stop.color,
                };

                if (stop.positionEnabled && stop.pos !== undefined) {
                    transformedStop.pos = stop.pos;
                }

                if (stop.levelEnabled && stop.level !== undefined) {
                    transformedStop.level = stop.level;
                }

                return transformedStop;
            });

            return {
                colorStops: transformedColorStops,
                ...(gradient.dir ? { dir: gradient.dir } : {}),
            };
        },
        [],
    );

    const registerCustomGradients = useCallback(
        (audioMotionInstance: any) => {
            if (visualizer.type !== 'audiomotionanalyzer') {
                return;
            }

            const customGradients = visualizer.audiomotionanalyzer.customGradients || [];

            customGradients.forEach((gradient) => {
                try {
                    const gradientConfig = transformGradientForVisualizer(gradient);

                    audioMotionInstance.registerGradient(gradient.name, gradientConfig as any);
                } catch (error) {
                    console.error(`Failed to register gradient "${gradient.name}":`, error);
                }
            });

            // Mark gradients as registered
            setGradientsRegistered(true);
        },
        [visualizer, transformGradientForVisualizer],
    );

    // Reading `options` / `isCustomGradient` / `registerCustomGradients` /
    // `visualizer` via refs inside the init effect so they don't drag the
    // effect into a tear-down-and-rebuild loop on every settings change.
    // Settings updates are handled by the dedicated `motion.setOptions`
    // effect further down.
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const visualizerRef = useRef(visualizer);
    visualizerRef.current = visualizer;
    const isCustomGradientRef = useRef(isCustomGradient);
    isCustomGradientRef.current = isCustomGradient;
    const registerCustomGradientsRef = useRef(registerCustomGradients);
    registerCustomGradientsRef.current = registerCustomGradients;

    useEffect(() => {
        const { context } = webAudio || {};
        const inputNodes = getVisualizerAudioNodes(webAudio, playbackType);
        const shouldRunForWebPlayback = playbackType === PlayerType.WEB && isPlaying;
        const shouldRunForMpvLoopback =
            playbackType === PlayerType.LOCAL && isPlaying && inputNodes.length > 0;

        let audioMotion: any | undefined;
        if (
            inputNodes.length > 0 &&
            context &&
            canvasRef.current &&
            !motion &&
            libraryLoaded &&
            (shouldRunForWebPlayback || shouldRunForMpvLoopback)
        ) {
            const AudioMotionAnalyzer = AudioMotionAnalyzerRef.current;
            if (!AudioMotionAnalyzer) return;

            // Reset gradients registered flag on new instance
            setGradientsRegistered(false);

            const opts = optionsRef.current;
            const viz = visualizerRef.current;
            const isCustom = isCustomGradientRef.current;
            // Create options without custom gradients on first init
            const initOptions: any = { ...opts };

            // Replace custom gradients with default 'classic' for initial setup
            if (viz.type === 'audiomotionanalyzer') {
                const ama = viz.audiomotionanalyzer;
                if (isCustom(ama.gradient)) initOptions.gradient = 'classic';
                if (isCustom(ama.gradientLeft)) initOptions.gradientLeft = 'classic';
                if (isCustom(ama.gradientRight)) initOptions.gradientRight = 'classic';
            }

            audioMotion = new AudioMotionAnalyzer(canvasRef.current, {
                ...initOptions,
                audioCtx: context,
            });

            // Register custom gradients (this will set gradientsRegistered to true)
            registerCustomGradientsRef.current(audioMotion);

            setMotion(audioMotion);
            for (const node of inputNodes) audioMotion.connectInput(node);
        }

        return () => {
            if (motion) {
                try {
                    motion.destroy();
                } catch {
                    // ignore (e.g. already destroyed by idle timer)
                }
                setMotion(undefined);
            }
        };
    }, [playbackType, webAudio, motion, libraryLoaded, isPlaying]);

    // Kill visualizer after 5 seconds of pause
    useEffect(() => {
        if (isPlaying) {
            if (pauseTimerRef.current) {
                clearTimeout(pauseTimerRef.current);
                pauseTimerRef.current = undefined;
            }
            return;
        }

        if (!motion) return;

        pauseTimerRef.current = setTimeout(() => {
            setMotion((current) => {
                if (current) {
                    try {
                        current.destroy();
                    } catch {
                        // ignore
                    }
                }
                return undefined;
            });
            pauseTimerRef.current = undefined;
        }, 5000);

        return () => {
            if (pauseTimerRef.current) {
                clearTimeout(pauseTimerRef.current);
                pauseTimerRef.current = undefined;
            }
        };
    }, [isPlaying, motion]);

    // Re-register custom gradients when they change
    useEffect(() => {
        if (motion && visualizer.type === 'audiomotionanalyzer') {
            setGradientsRegistered(false);
            registerCustomGradients(motion);
        }
    }, [
        motion,
        registerCustomGradients,
        visualizer.audiomotionanalyzer.customGradients,
        visualizer.type,
    ]);

    // Update visualizer settings when they change. Debounce the apply so that
    // dragging a settings slider (which emits a flurry of option objects)
    // coalesces into a single setOptions call once the drag settles, instead
    // of reconfiguring the analyzer on every intermediate value.
    useEffect(() => {
        if (!motion) return;

        const handle = setTimeout(() => {
            motion.setOptions(options);
        }, 50);

        return () => {
            clearTimeout(handle);
        };
    }, [motion, options]);

    // Fully suspend AudioMotionAnalyzer's internal rAF loop while the
    // window/tab is hidden, and honor prefers-reduced-motion. Unlike
    // butterchurn (which we drive with our own rAF loop), AudioMotionAnalyzer
    // runs its own loop internally; stop()/start() toggles it. Electron
    // windows behind another window still get full rAF, so leaning on the
    // browser's background throttling isn't enough to save GPU/battery.
    useEffect(() => {
        if (!motion) return;

        const reducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        const apply = () => {
            const shouldRun =
                !reducedMotion && !(typeof document !== 'undefined' && document.hidden);
            try {
                if (shouldRun) {
                    if (!motion.isOn) motion.start();
                } else if (motion.isOn) {
                    motion.stop();
                }
            } catch {
                // ignore (e.g. instance destroyed mid-toggle)
            }
        };

        apply();

        if (reducedMotion) {
            // Static under reduced-motion; nothing to listen for.
            return;
        }

        document.addEventListener('visibilitychange', apply);
        return () => {
            document.removeEventListener('visibilitychange', apply);
        };
    }, [motion]);

    return <div className={styles.visualizer} ref={canvasRef} style={{ opacity }} />;
};

export interface VisualizerProps {
    // Background mode: the visualizer renders BEHIND other UI (e.g. as the
    // mobile fullscreen player's backdrop). Its controls would be visible
    // but non-interactive back there — render none at all.
    chromeless?: boolean;
    // When rendered inside the dedicated full-screen visualizer overlay, the
    // overlay supplies its own close / configure controls. Hiding this
    // component's built-in top icon-group avoids a second, redundant control
    // cluster colliding with the overlay's close button.
    hideTopControls?: boolean;
}

export const Visualizer = ({ chromeless, hideTopControls }: VisualizerProps = {}) => {
    const { t } = useTranslation();
    const { visualizerExpanded } = useFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();
    const isMobile = useIsMobileShell();
    // Touch has no hover: reveal controls on touch, hide after an idle
    // delay. Desktop keeps the CSS :hover gating (see the module css).
    const { controlsVisible, revealControls } = useIdleControls();

    const handleToggleFullscreen = () => {
        setStore({ expanded: false, visualizerExpanded: !visualizerExpanded });
    };

    const showControls = !chromeless && !hideTopControls && (!isMobile || controlsVisible);

    return (
        <div
            className={styles.container}
            onTouchStart={isMobile && !chromeless ? revealControls : undefined}
        >
            {showControls && (
                <Group className={`${styles.iconGroup} ${styles.iconGroupTop}`} gap="xs">
                    <ActionIcon
                        aria-label={t('player.toggleFullscreenPlayer')}
                        icon="expand"
                        iconProps={{ size: 'lg' }}
                        onClick={handleToggleFullscreen}
                        tooltip={{ label: t('player.toggleFullscreenPlayer'), openDelay: 400 }}
                        variant="subtle"
                    />
                    <ActionIcon
                        aria-label={t('common.settings')}
                        icon="settings2"
                        iconProps={{ size: 'lg' }}
                        onClick={openVisualizerSettingsModal}
                        tooltip={{ label: t('common.settings'), openDelay: 400 }}
                        variant="subtle"
                    />
                </Group>
            )}
            <ComponentErrorBoundary>
                <VisualizerInner />
            </ComponentErrorBoundary>
        </div>
    );
};
