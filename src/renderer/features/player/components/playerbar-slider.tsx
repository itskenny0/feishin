import formatDuration from 'format-duration';
import { lazy, Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { PlayerbarSeekSlider } from './playerbar-seek-slider';
import styles from './playerbar-slider.module.css';

import { useActivePlayerSource } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { ScrobbleStatus } from '/@/renderer/features/player/components/scrobble-status';
import { TrackmapCanvas } from '/@/renderer/features/trackmap';
import { useAppStore, useAppStoreActions, usePlayerTimestamp } from '/@/renderer/store';
import {
    PlayerbarSliderType,
    usePlayerbarSlider,
    useTrackmapEnabled,
} from '/@/renderer/store/settings.store';
import { Slider, SliderProps } from '/@/shared/components/slider/slider';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Text } from '/@/shared/components/text/text';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';

const PlayerbarWaveform = lazy(() =>
    import('./playerbar-waveform').then((module) => ({
        default: module.PlayerbarWaveform,
    })),
);

/**
 * Right-side time readout. Subscribes to the playback timestamp only here, so
 * the rest of `<PlayerbarSlider />` doesn't re-render on every tick.
 *
 * When a remote Jellyfin device is the active target, currentTimeSec is
 * passed in from the parent (sourced from the mirrored remote state).
 * Otherwise it falls back to the local player's tick subscription.
 */
const DurationReadout = ({
    currentTimeSec,
    songDurationSec,
}: {
    currentTimeSec?: number;
    songDurationSec: number;
}) => {
    const showTimeRemaining = useAppStore((state) => state.showTimeRemaining);
    const { setShowTimeRemaining } = useAppStoreActions();
    const localTime = usePlayerTimestamp();
    const currentTime = currentTimeSec ?? localTime;

    const text = showTimeRemaining
        ? formatDuration((currentTime - songDurationSec) * 1000 || 0)
        : formatDuration(songDurationSec * 1000 || 0);

    return (
        <Text
            className={PlaybackSelectors.totalDuration}
            fw={600}
            isMuted
            isNoSelect
            onClick={() => setShowTimeRemaining(!showTimeRemaining)}
            role="button"
            size="xs"
            style={{ cursor: 'pointer', userSelect: 'none' }}
        >
            {text}
        </Text>
    );
};

export const PlayerbarSlider = () => {
    const source = useActivePlayerSource();
    const currentSong = source.nowPlayingItem;
    const playerbarSlider = usePlayerbarSlider();

    const songDuration = currentSong?.duration ? currentSong.duration / 1000 : 0;
    // When the active player is a remote Jellyfin device, hand its
    // mirrored position to the readout. Local mode leaves it undefined so
    // DurationReadout falls back to its own usePlayerTimestamp subscription.
    const remoteTimeSec = source.mode === 'remote' ? source.positionMs / 1000 : undefined;

    const isWaveform = playerbarSlider?.type === PlayerbarSliderType.WAVEFORM;
    const trackmapEnabled = useTrackmapEnabled();

    return (
        <div className={styles.sliderContainer}>
            <div className={styles.sliderValueWrapperElapsed}>
                <ScrobbleStatus />
            </div>
            <div className={styles.sliderWrapper}>
                {isWaveform ? (
                    <Suspense fallback={<Spinner />}>
                        <PlayerbarWaveform />
                    </Suspense>
                ) : (
                    <>
                        {trackmapEnabled && (
                            // The trackmap is purely decorative; if it errors,
                            // silently degrade to no-trackmap rather than
                            // jamming a fallback error message into the
                            // 20-px slider gutter.
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
            <div className={styles.sliderValueWrapper}>
                <DurationReadout currentTimeSec={remoteTimeSec} songDurationSec={songDuration} />
            </div>
        </div>
    );
};

export const CustomPlayerbarSlider = ({ ...props }: SliderProps) => {
    return (
        <Slider
            classNames={{
                bar: styles.bar,
                label: styles.label,
                root: styles.root,
                thumb: styles.thumb,
                track: styles.track,
            }}
            {...props}
            size={6}
        />
    );
};
