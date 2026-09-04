import { memo } from 'react';

import styles from './mobile-fullscreen-player.module.css';

import { AutoDJButton } from '/@/renderer/features/player/components/right-controls';
import { SharedFullscreenPlayerSettings } from '/@/renderer/features/player/components/shared-full-screen-player-settings';
import { SleepTimerButton } from '/@/renderer/features/player/components/sleep-timer-button';
import { useFullScreenPlayerStore } from '/@/renderer/store';

export const MobileFullscreenPlayerHeader = memo(() => {
    const { opacity } = useFullScreenPlayerStore();

    return (
        <div
            className={styles.header}
            style={{
                background: `rgb(var(--theme-colors-background-transparent), ${opacity}%)`,
            }}
        >
            <SharedFullscreenPlayerSettings />
            {/* Sleep timer + auto-DJ are otherwise desktop-only — mobile users
                couldn't reach either from the collapsed playerbar. Surface both
                in the fullscreen player header where there's room. */}
            <SleepTimerButton />
            <AutoDJButton />
        </div>
    );
});

MobileFullscreenPlayerHeader.displayName = 'MobileFullscreenPlayerHeader';
