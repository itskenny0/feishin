import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { RiFullscreenLine } from 'react-icons/ri';

import styles from './mobile-fullscreen-player.module.css';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import { usePlaybackSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';

/**
 * Visualizer entry-point card in the mobile fullscreen player's scroll
 * stack.
 *
 * Earlier revisions embedded the audiomotionanalyzer / butterchurn
 * canvas directly inside the card surface, but on the user's device
 * the card simply never appeared no matter what styling we threw at
 * it. Most likely cause: one of the lazy-loaded visualizer chunks was
 * failing to resolve on Capacitor's WebView and our ComponentErrorBoundary
 * was swallowing the failure silently — but the outer card render
 * also somehow got lost in the noise.
 *
 * Strip the card to the absolute minimum: a plain panel with a label,
 * a fullscreen-icon button, and an "Open visualizer" CTA. No hooks
 * that touch the visualizer settings slice, no lazy imports, no
 * Suspense, no inner canvas. Tapping anywhere opens the existing
 * fullscreen visualizer overlay (where the canvas actually lives and
 * has been working reliably).
 *
 * The card hides when `visualizerAsBackground` is on — the user
 * already sees the visualizer behind the player face, no need for a
 * second entry point.
 */
export const MobileFullscreenVisualizerCard = memo(() => {
    const { t } = useTranslation();
    const { webAudio } = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();
    const { visualizerAsBackground } = useFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();

    if (visualizerAsBackground) {
        return null;
    }

    const handleOpen = () => {
        triggerHaptic('selection');
        // Enable Web Audio if needed — the visualizer overlay's canvas
        // requires it. Flip on, then open. The AudioContext is set up
        // by the useEffect in AudioPlayersContent that keys on the
        // webAudio setting, so no restart is required.
        if (!webAudio) {
            setSettings({ playback: { webAudio: true } });
        }
        setStore({ visualizerExpanded: true });
    };

    return (
        <div className={styles.visualizerCard}>
            <div className={styles.visualizerCardHeader}>
                <span>{t('page.fullscreenPlayer.visualizer', { defaultValue: 'Visualizer' })}</span>
                <ActionIcon
                    aria-label={t('common.expand', { defaultValue: 'Expand' })}
                    onClick={handleOpen}
                    size="md"
                    variant="subtle"
                >
                    <RiFullscreenLine />
                </ActionIcon>
            </div>
            <div className={styles.visualizerCardEmptyState}>
                <p className={styles.visualizerCardEmptyText}>
                    {t('page.fullscreenPlayer.visualizerHint', {
                        defaultValue: 'Tap to open the fullscreen audio visualizer.',
                    })}
                </p>
                <Button onClick={handleOpen} variant="filled">
                    {t('common.open', { defaultValue: 'Open' })}
                </Button>
            </div>
        </div>
    );
});

MobileFullscreenVisualizerCard.displayName = 'MobileFullscreenVisualizerCard';
