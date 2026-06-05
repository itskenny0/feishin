import formatDuration from 'format-duration';
import { lazy, memo, Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { PlayerbarSeekSlider } from './playerbar-seek-slider';
import styles from './playerbar-slider.module.css';

import {
    useActivePlayerSource,
    useRemoteInterpolatedPositionMs,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { ScrobbleStatus } from '/@/renderer/features/player/components/scrobble-status';
import { TrackmapCanvas } from '/@/renderer/features/trackmap';
import { useAppStore, useAppStoreActions, usePlayerTimestamp } from '/@/renderer/store';
import {
    PlayerbarSliderType,
    usePlayerbarSlider,
    useTrackmapEnabled,
} from '/@/renderer/store/settings.store';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Slider, SliderProps } from '/@/shared/components/slider/slider';
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
 * When a remote Jellyfin device is the active target, this leaf subscribes to
 * the interpolated remote position itself (gated to the `isRemote` boolean
 * passed from the parent). Confining the high-frequency position read to this
 * leaf — instead of subscribing in PlayerbarSlider — keeps ScrobbleStatus /
 * TrackmapCanvas / the waveform Suspense boundary out of the per-tick render
 * path. Local mode falls back to the local player's tick subscription.
 *
 * The gate is the explicit `isRemote` boolean (not `remotePositionMs ??
 * localTime`) because `useRemoteInterpolatedPositionMs` returns 0 — never
 * undefined — in local mode.
 */
const DurationReadout = ({
    isRemote,
    songDurationSec,
}: {
    isRemote: boolean;
    songDurationSec: number;
}) => {
    const showTimeRemaining = useAppStore((state) => state.showTimeRemaining);
    const { setShowTimeRemaining } = useAppStoreActions();
    const localTime = usePlayerTimestamp();
    const remotePositionMs = useRemoteInterpolatedPositionMs();
    const currentTime = isRemote ? remotePositionMs / 1000 : localTime;

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
    // Subscribe to the cheap `isRemote` primitive here and hand it to the
    // DurationReadout leaf, which owns the high-frequency interpolated-position
    // subscription. Keeping the per-tick position read out of PlayerbarSlider
    // means ScrobbleStatus / TrackmapCanvas / the waveform Suspense boundary
    // don't reconcile on every remote frame — they only re-render on song /
    // source changes.
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);

    const isWaveform = playerbarSlider?.type === PlayerbarSliderType.WAVEFORM;
    const trackmapEnabled = useTrackmapEnabled();

    return (
        <div className={styles.sliderContainer}>
            <div className={styles.sliderValueWrapperElapsed}>
                <ScrobbleStatus />
            </div>
            <div className={styles.sliderWrapper}>
                {isWaveform ? (
                    <Suspense fallback={<Skeleton enableAnimation height={30} width="100%" />}>
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
                <DurationReadout isRemote={isRemote} songDurationSec={songDuration} />
            </div>
        </div>
    );
};

// Hoisted to a module constant so the classNames object identity is stable
// across the ~20fps position ticks; otherwise a fresh object every tick forces
// Mantine's Slider to reconcile its whole subtree on each frame.
const PLAYERBAR_SLIDER_CLASSNAMES = {
    bar: styles.bar,
    label: styles.label,
    root: styles.root,
    thumb: styles.thumb,
};

// Wrapped in React.memo so that, with the seek slider now passing stable
// (memoized) callbacks/style props, only `value` changing per tick triggers a
// re-render here instead of a full reconciliation on every parent render.
export const CustomPlayerbarSlider = memo(({ ...props }: SliderProps) => {
    return <Slider classNames={PLAYERBAR_SLIDER_CLASSNAMES} {...props} size={6} />;
});

CustomPlayerbarSlider.displayName = 'CustomPlayerbarSlider';
