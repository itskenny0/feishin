import { memo } from 'react';

import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import { usePlaybackSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';

/**
 * Nuclear-debug version. The previous styled card showed only its
 * border on the user's device — the content area collapsed to 0
 * height even with padded flex children. Most likely cause: the CSS
 * module class for visualizer-card-empty-state isn't being delivered
 * to the deployed bundle, so `styles.visualizerCardEmptyState`
 * resolves to undefined, no padding applies, and the children
 * collapse to zero intrinsic height (an empty <p> + a Button that
 * also has 0 intrinsic height before its styles kick in).
 *
 * This version uses only inline styles, no module CSS, no
 * useTranslation, no ActionIcon, no Button. If THIS renders, the bug
 * is in CSS module delivery. If it still doesn't, the bug is in the
 * component-render path itself and we need to chase upstream.
 */
export const MobileFullscreenVisualizerCard = memo(() => {
    const { webAudio } = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();
    const { visualizerAsBackground } = useFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();

    if (visualizerAsBackground) {
        return null;
    }

    const handleOpen = () => {
        if (!webAudio) {
            setSettings({ playback: { webAudio: true } });
        }
        setStore({ visualizerExpanded: true });
    };

    return (
        <div
            style={{
                background: '#c026d3',
                border: '3px solid #fde047',
                borderRadius: '12px',
                color: '#fff',
                margin: '16px',
                minHeight: '160px',
                padding: '20px',
            }}
        >
            <div
                style={{
                    fontSize: '20px',
                    fontWeight: 800,
                    marginBottom: '12px',
                }}
            >
                DEBUG VISUALIZER CARD
            </div>
            <div style={{ fontSize: '14px', marginBottom: '16px' }}>
                If you can read this, the card render path works. The previous styling was
                collapsing because the CSS-module classes were not being applied to the body.
            </div>
            <button
                onClick={handleOpen}
                style={{
                    background: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#c026d3',
                    cursor: 'pointer',
                    fontWeight: 700,
                    padding: '10px 20px',
                }}
                type="button"
            >
                Open visualizer
            </button>
        </div>
    );
});

MobileFullscreenVisualizerCard.displayName = 'MobileFullscreenVisualizerCard';
