import { lazy, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { RiFullscreenLine } from 'react-icons/ri';

import styles from './mobile-fullscreen-player.module.css';

import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import {
    usePlaybackSettings,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';

const AudioMotionAnalyzerVisualizer = lazy(() =>
    import('/@/renderer/features/visualizer/components/audiomotionanalyzer/visualizer').then(
        (module) => ({ default: module.Visualizer }),
    ),
);

const ButterchurnVisualizer = lazy(() =>
    import('/@/renderer/features/visualizer/components/butternchurn/visualizer').then((module) => ({
        default: module.Visualizer,
    })),
);

/**
 * Inline visualizer preview card. Sits at the bottom of the mobile
 * fullscreen player's scroll stack at 50dvh and shows a live visualizer
 * the user can tap to fullscreen.
 *
 * Always renders, even with webAudio disabled, so the user can find the
 * visualizer surface from the card stack and enable it inline. When
 * Web Audio is off we render a CTA inside the card that flips webAudio
 * on (no app restart needed for the visualizer; the AudioContext is set
 * up by the useEffect in AudioPlayersContent which keys on the
 * webAudio setting).
 *
 * Only renders the analyzer when the fullscreen visualizer overlay is
 * NOT already open — otherwise both would compete for the same Web
 * Audio analyzer nodes and the canvases would race. When the user taps
 * "expand", we set visualizerExpanded=true and the overlay takes over;
 * this card hides its analyzer until the overlay closes.
 */
export const MobileFullscreenVisualizerCard = memo(() => {
    const { t } = useTranslation();
    const { webAudio } = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();
    const visualizerType = useSettingsStore((store) => store.visualizer.type);
    const { visualizerAsBackground, visualizerExpanded } = useFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();

    /*
     * When the visualizer is already painting as the fullscreen
     * player's background, surfacing it again inside this card would
     * be (a) redundant and (b) wasteful — two visualizer instances
     * compete for the same Web Audio analyzer nodes and the canvases
     * race each other for paint cycles. Skip this card entirely in
     * that mode.
     */
    if (visualizerAsBackground) {
        return null;
    }

    const handleExpand = () => {
        triggerHaptic('selection');
        setStore({ visualizerExpanded: true });
    };

    const handleEnableAndExpand = () => {
        triggerHaptic('selection');
        setSettings({ playback: { webAudio: true } });
        setStore({ visualizerExpanded: true });
    };

    return (
        <div className={styles.visualizerCard}>
            <div className={styles.visualizerCardHeader}>
                <span>{t('page.fullscreenPlayer.visualizer', { defaultValue: 'Visualizer' })}</span>
                {webAudio && (
                    <ActionIcon
                        aria-label={t('common.expand', { defaultValue: 'Expand' })}
                        onClick={handleExpand}
                        size="md"
                        variant="subtle"
                    >
                        <RiFullscreenLine />
                    </ActionIcon>
                )}
            </div>
            {webAudio ? (
                <div className={styles.visualizerCardSurface} onClick={handleExpand}>
                    {!visualizerExpanded && (
                        <ComponentErrorBoundary>
                            <Suspense fallback={null}>
                                {visualizerType === 'butterchurn' ? (
                                    <ButterchurnVisualizer />
                                ) : (
                                    <AudioMotionAnalyzerVisualizer />
                                )}
                            </Suspense>
                        </ComponentErrorBoundary>
                    )}
                    {/*
                     * Always-visible hint sitting in the middle of the
                     * surface. Without this the card looks blank when
                     * playback is paused (the visualizer libs only start
                     * drawing once `isPlaying` is true), and users
                     * couldn't tell whether the card was rendering or
                     * not. The hint also doubles as a tap affordance.
                     */}
                    <span className={styles.visualizerCardHint}>
                        {t('page.fullscreenPlayer.tapToExpandVisualizer', {
                            defaultValue: 'Tap to open',
                        })}
                    </span>
                </div>
            ) : (
                <div className={styles.visualizerCardEmptyState}>
                    <p className={styles.visualizerCardEmptyText}>
                        {t('page.fullscreenPlayer.visualizerNeedsWebAudio', {
                            defaultValue:
                                'Web Audio is off. Enable it to drive the visualizer — the toggle also lives under Settings → Playback.',
                        })}
                    </p>
                    <Button onClick={handleEnableAndExpand} variant="filled">
                        {t('page.fullscreenPlayer.enableVisualizer', {
                            defaultValue: 'Enable visualizer',
                        })}
                    </Button>
                </div>
            )}
        </div>
    );
});

MobileFullscreenVisualizerCard.displayName = 'MobileFullscreenVisualizerCard';
