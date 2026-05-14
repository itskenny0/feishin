import formatDuration from 'format-duration';
import { lazy, Suspense } from 'react';

import { PlayerbarSeekSlider } from './playerbar-seek-slider';
import styles from './playerbar-slider.module.css';

import { ScrobbleStatus } from '/@/renderer/features/player/components/scrobble-status';
import {
    useAppStore,
    useAppStoreActions,
    usePlayerSong,
    usePlayerTimestamp,
} from '/@/renderer/store';
import { PlayerbarSliderType, usePlayerbarSlider } from '/@/renderer/store/settings.store';
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
 */
const DurationReadout = ({ songDurationSec }: { songDurationSec: number }) => {
    const showTimeRemaining = useAppStore((state) => state.showTimeRemaining);
    const { setShowTimeRemaining } = useAppStoreActions();
    const currentTime = usePlayerTimestamp();

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
    const currentSong = usePlayerSong();
    const playerbarSlider = usePlayerbarSlider();

    const songDuration = currentSong?.duration ? currentSong.duration / 1000 : 0;

    const isWaveform = playerbarSlider?.type === PlayerbarSliderType.WAVEFORM;

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
                    <PlayerbarSeekSlider max={songDuration} min={0} />
                )}
            </div>
            <div className={styles.sliderValueWrapper}>
                <DurationReadout songDurationSec={songDuration} />
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
