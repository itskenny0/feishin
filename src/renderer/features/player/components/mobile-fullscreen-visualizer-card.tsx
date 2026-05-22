import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { RiFullscreenLine } from 'react-icons/ri';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import { usePlaybackSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';

/**
 * Visualizer entry-point card in the mobile fullscreen player's scroll
 * stack.
 *
 * Styled with inline styles rather than the module CSS because the
 * classes I added to mobile-fullscreen-player.module.css for this
 * card never made it into the deployed bundle on the user's device —
 * suspect a CSS-modules parser glitch around the `:not()` selector I
 * had between the rules. The debug build with inline styles rendered
 * correctly, so we stick with that here. The colours roughly mirror
 * the other scroll-down cards (artist / lyrics / album) so it visually
 * sits with them.
 *
 * Hides entirely when `visualizerAsBackground` is on — the user is
 * already seeing the visualizer behind the player face and a second
 * surface in the scroll stack would be redundant.
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
        // Flip Web Audio on if it isn't already — the AudioContext is
        // wired up by the useEffect in AudioPlayersContent which keys
        // off this setting, so no restart is required for the
        // visualizer to start drawing.
        if (!webAudio) {
            setSettings({ playback: { webAudio: true } });
        }
        setStore({ visualizerExpanded: true });
    };

    return (
        <div
            aria-label={t('page.fullscreenPlayer.visualizer', { defaultValue: 'Visualizer' })}
            onClick={handleOpen}
            role="button"
            style={{
                background: 'rgb(20 20 28 / 92%)',
                border: '1px solid rgb(255 255 255 / 14%)',
                borderRadius: '12px',
                color: '#fff',
                cursor: 'pointer',
                margin: '0 16px calc(var(--theme-spacing-lg, 16px) * 2 + env(safe-area-inset-bottom, 0px))',
                padding: '18px 18px 20px',
            }}
            tabIndex={0}
        >
            <div
                style={{
                    alignItems: 'center',
                    display: 'flex',
                    fontSize: '1.05rem',
                    fontWeight: 800,
                    justifyContent: 'space-between',
                    letterSpacing: '-0.01em',
                    marginBottom: '10px',
                }}
            >
                <span>{t('page.fullscreenPlayer.visualizer', { defaultValue: 'Visualizer' })}</span>
                <RiFullscreenLine size={22} />
            </div>
            <div
                style={{
                    color: 'rgb(255 255 255 / 65%)',
                    fontSize: '0.9rem',
                    lineHeight: 1.4,
                    marginBottom: '14px',
                }}
            >
                {t('page.fullscreenPlayer.visualizerHint', {
                    defaultValue: 'Tap to open the fullscreen audio visualizer.',
                })}
            </div>
            <button
                onClick={(e) => {
                    // Stop the outer div's click handler from firing
                    // too — both end up calling handleOpen anyway, but
                    // a double-fire briefly flashed the haptic.
                    e.stopPropagation();
                    handleOpen();
                }}
                style={{
                    background: '#fff',
                    border: 'none',
                    borderRadius: '999px',
                    color: '#000',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    fontWeight: 700,
                    padding: '8px 18px',
                }}
                type="button"
            >
                {t('common.open', { defaultValue: 'Open' })}
            </button>
        </div>
    );
});

MobileFullscreenVisualizerCard.displayName = 'MobileFullscreenVisualizerCard';
