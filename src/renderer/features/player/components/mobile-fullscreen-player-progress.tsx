import formatDuration from 'format-duration';
import { CSSProperties, lazy, memo, Suspense, useMemo } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import styles from './mobile-fullscreen-player.module.css';

import { useRemoteInterpolatedPositionMs } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { PlayerbarSeekSlider } from '/@/renderer/features/player/components/playerbar-seek-slider';
import { TrackmapCanvas } from '/@/renderer/features/trackmap';
import { usePlayerTimestamp } from '/@/renderer/store';
import {
    PlayerbarSliderType,
    usePlayerbarSlider,
    useTrackmapEnabled,
} from '/@/renderer/store/settings.store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Text } from '/@/shared/components/text/text';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';
import { Song } from '/@/shared/types/domain-types';

const PlayerbarWaveform = lazy(() =>
    import('/@/renderer/features/player/components/playerbar-waveform').then((module) => ({
        default: module.PlayerbarWaveform,
    })),
);

interface MobileFullscreenPlayerProgressProps {
    currentSong?: Song;
}

// Hoisted to module scope so the constant style objects are referentially
// stable across renders — child memoization (PlayerbarSeekSlider) can then
// bail out instead of being walked on every per-tick render.
const ELAPSED_STYLE: CSSProperties = { textAlign: 'right' };
const TOTAL_STYLE: CSSProperties = { textAlign: 'left' };
const SLIDER_WRAP_STYLE: CSSProperties = { position: 'relative', width: '100%', zIndex: 1 };

/**
 * Elapsed-time readout extracted into its own memoized leaf that owns the
 * high-frequency interpolated-position subscription. This keeps the slider
 * wrapper and the (invariant-per-track) total-duration Text outside the
 * per-tick render path — only this small Text reconciles as the position
 * advances. Local mode falls back to the local player's tick subscription;
 * the gate is the explicit `isRemote` boolean because
 * useRemoteInterpolatedPositionMs returns 0 — not undefined — in local mode.
 */
const ElapsedTimeText = memo(({ isRemote }: { isRemote: boolean }) => {
    const localTime = usePlayerTimestamp();
    const remotePositionMs = useRemoteInterpolatedPositionMs();
    const currentTime = isRemote ? remotePositionMs / 1000 : localTime;
    const formattedTime = formatDuration(currentTime * 1000 || 0);
    return (
        <Text className={PlaybackSelectors.elapsedTime} size="xs" style={ELAPSED_STYLE}>
            {formattedTime}
        </Text>
    );
});
ElapsedTimeText.displayName = 'ElapsedTimeText';

export const MobileFullscreenPlayerProgress = memo(
    ({ currentSong }: MobileFullscreenPlayerProgressProps) => {
        const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
        const playerbarSlider = usePlayerbarSlider();
        const songDuration = currentSong?.duration ? currentSong.duration / 1000 : 0;
        // Invariant per track — recomputing formatDuration on every position
        // tick is wasted work, so memoize on songDuration only.
        const formattedDuration = useMemo(
            () => formatDuration(songDuration * 1000 || 0),
            [songDuration],
        );

        const isWaveform = playerbarSlider?.type === PlayerbarSliderType.WAVEFORM;
        const trackmapEnabled = useTrackmapEnabled();

        return (
            <div className={styles.progressContainer}>
                <div className={styles.timeContainer}>
                    <ElapsedTimeText isRemote={isRemote} />
                </div>
                <div className={styles.sliderWrapper}>
                    {isWaveform ? (
                        <Suspense fallback={<Spinner />}>
                            <PlayerbarWaveform />
                        </Suspense>
                    ) : (
                        <>
                            {trackmapEnabled && (
                                /*
                                 * Trackmap on the mobile fullscreen player.
                                 * The canvas paints behind the seek slider —
                                 * same component the desktop playerbar uses;
                                 * ErrorBoundary keeps a per-track parse
                                 * failure from blowing up the whole row.
                                 */
                                <ErrorBoundary fallback={null}>
                                    <TrackmapCanvas />
                                </ErrorBoundary>
                            )}
                            <div style={SLIDER_WRAP_STYLE}>
                                <PlayerbarSeekSlider max={songDuration} min={0} />
                            </div>
                        </>
                    )}
                </div>
                <div className={styles.timeContainer}>
                    <Text className={PlaybackSelectors.totalDuration} size="xs" style={TOTAL_STYLE}>
                        {formattedDuration}
                    </Text>
                </div>
            </div>
        );
    },
);

MobileFullscreenPlayerProgress.displayName = 'MobileFullscreenPlayerProgress';
