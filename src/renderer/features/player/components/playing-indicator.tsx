import clsx from 'clsx';

import styles from './playing-indicator.module.css';

import { usePlayerStatus } from '/@/renderer/store/player.store';
import { PlayerStatus } from '/@/shared/types/types';

export interface PlayingIndicatorProps {
    className?: string;
    /**
     * Render the bars even when paused. They stop animating but stay
     * visible. Default true — most "now playing" UIs keep them on so
     * the affordance doesn't flash when the user pauses.
     */
    visibleWhenPaused?: boolean;
}

/**
 * Three small bars that pulse up and down at staggered phases while audio
 * is playing. Each bar has its own infinite-loop keyframe at a slightly
 * different period (450 / 600 / 530 ms) so the cluster reads as organic
 * sound, not a metronome. Animation pauses (CSS animation-play-state)
 * when the player isn't PLAYING — the bars freeze at their current
 * height for as long as the user is paused.
 *
 * Respects prefers-reduced-motion (no animation; bars stay at a static
 * mid height so the affordance is still visible).
 */
export const PlayingIndicator = ({
    className,
    visibleWhenPaused = true,
}: PlayingIndicatorProps) => {
    const status = usePlayerStatus();
    const isPlaying = status === PlayerStatus.PLAYING;
    const isPaused = status === PlayerStatus.PAUSED;

    if (!isPlaying && !visibleWhenPaused) return null;
    if (!isPlaying && !isPaused) return null; // no song loaded → hide

    return (
        <span
            aria-hidden
            className={clsx(
                styles.indicator,
                isPlaying ? styles.playing : styles.paused,
                className,
            )}
            role="presentation"
        >
            <span className={styles.bar} />
            <span className={styles.bar} />
            <span className={styles.bar} />
        </span>
    );
};
