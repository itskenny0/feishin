import formatDuration from 'format-duration';
import { lazy, memo, Suspense } from 'react';
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

export const MobileFullscreenPlayerProgress = memo(
    ({ currentSong }: MobileFullscreenPlayerProgressProps) => {
        const localTime = usePlayerTimestamp();
        const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
        const remotePositionMs = useRemoteInterpolatedPositionMs();
        // Elapsed-time readout: interpolated remote position in remote mode,
        // local timestamp otherwise. The seek slider below is already
        // remote-aware on its own.
        const currentTime = isRemote ? remotePositionMs / 1000 : localTime;
        const playerbarSlider = usePlayerbarSlider();
        const songDuration = currentSong?.duration ? currentSong.duration / 1000 : 0;
        const formattedDuration = formatDuration(songDuration * 1000 || 0);
        const formattedTime = formatDuration(currentTime * 1000 || 0);

        const isWaveform = playerbarSlider?.type === PlayerbarSliderType.WAVEFORM;
        const trackmapEnabled = useTrackmapEnabled();

        return (
            <div className={styles.progressContainer}>
                <div className={styles.timeContainer}>
                    <Text
                        className={PlaybackSelectors.elapsedTime}
                        size="xs"
                        style={{ textAlign: 'right' }}
                    >
                        {formattedTime}
                    </Text>
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
                            <div style={{ position: 'relative', width: '100%', zIndex: 1 }}>
                                <PlayerbarSeekSlider max={songDuration} min={0} />
                            </div>
                        </>
                    )}
                </div>
                <div className={styles.timeContainer}>
                    <Text
                        className={PlaybackSelectors.totalDuration}
                        size="xs"
                        style={{ textAlign: 'left' }}
                    >
                        {formattedDuration}
                    </Text>
                </div>
            </div>
        );
    },
);

MobileFullscreenPlayerProgress.displayName = 'MobileFullscreenPlayerProgress';
