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
import { usePlaybackSettings, useSettingsStore } from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';

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
 * Only renders the analyzer when the fullscreen visualizer overlay is
 * NOT already open — otherwise both would compete for the same Web
 * Audio analyzer nodes and the canvases would race. When the user taps
 * "expand", we set visualizerExpanded=true and the overlay takes over;
 * this card hides its analyzer until the overlay closes.
 *
 * Gated on `webAudio` being enabled (no analyzer to draw without it).
 */
export const MobileFullscreenVisualizerCard = memo(() => {
    const { t } = useTranslation();
    const { webAudio } = usePlaybackSettings();
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
    if (!webAudio || visualizerAsBackground) {
        return null;
    }

    const handleExpand = () => {
        triggerHaptic('selection');
        setStore({ visualizerExpanded: true });
    };

    return (
        <div className={styles.visualizerCard}>
            <div className={styles.visualizerCardHeader}>
                <span>{t('page.fullscreenPlayer.visualizer', { defaultValue: 'Visualizer' })}</span>
                <ActionIcon
                    aria-label={t('common.expand', { defaultValue: 'Expand' })}
                    onClick={handleExpand}
                    size="md"
                    variant="subtle"
                >
                    <RiFullscreenLine />
                </ActionIcon>
            </div>
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
            </div>
        </div>
    );
});

MobileFullscreenVisualizerCard.displayName = 'MobileFullscreenVisualizerCard';
