import formatDuration from 'format-duration';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CustomPlayerbarSlider } from './playerbar-slider';

import {
    useActivePlayerSource,
    useRemoteInterpolatedPositionMs,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { usePlayerTimestamp } from '/@/renderer/store';

interface PlayerbarSeekSliderProps {
    max: number;
    min: number;
}

// Transcoded streams (high-bitrate FLAC, radio re-encoding) routinely take
// 2-4s to land a seek; a 1s fallback snapped the slider back to the old
// position before the seek completed.
const SEEK_RESOLVE_MS = 5000;

// Wrapped in React.memo so a parent re-render (e.g. PlayerbarSlider
// reconciling on a song/source change) doesn't reconcile this comparatively
// expensive Mantine slider - it only re-renders when its own max/min props
// change or its own (now ~20fps-gated) position subscription emits.
const PlayerbarSeekSliderBase = ({ max, min }: PlayerbarSeekSliderProps) => {
    const [isSeeking, setIsSeeking] = useState(false);
    const [seekValue, setSeekValue] = useState(0);
    const source = useActivePlayerSource();
    const localTime = usePlayerTimestamp();
    const remotePositionMs = useRemoteInterpolatedPositionMs();
    const currentTime = source.mode === 'remote' ? remotePositionMs / 1000 : localTime;
    const canSeek = useTransportEnabled('Seek');
    const { mediaSeekToTimestamp } = usePlayer();
    const releasedAtRef = useRef<null | number>(null);
    // Read by handleChangeEnd so its identity doesn't churn on every position tick.
    const currentTimeRef = useRef(currentTime);

    useEffect(() => {
        currentTimeRef.current = currentTime;
    }, [currentTime]);

    // All of the slider's props except `value` are hoisted to stable
    // identities (memoized callbacks / style / label fn) so that - together
    // with CustomPlayerbarSlider being React.memo'd - only the per-tick
    // `value` change forces a slider re-render.
    const label = useCallback((value: number) => formatDuration(value * 1000), []);

    const handleChange = useCallback((e: number) => {
        releasedAtRef.current = null;
        setIsSeeking(true);
        setSeekValue(e);
    }, []);

    const handleChangeEnd = useCallback(
        (e: number) => {
            setSeekValue(e);
            mediaSeekToTimestamp(e);

            if (Math.abs(currentTimeRef.current - e) < 0.5) {
                setIsSeeking(false);
                releasedAtRef.current = null;
            } else {
                releasedAtRef.current = Date.now();
            }
        },
        [mediaSeekToTimestamp],
    );

    const handleClick = useCallback((e?: { stopPropagation: () => void }) => {
        e?.stopPropagation();
    }, []);

    const sliderStyle = useMemo(() => ({ opacity: canSeek ? undefined : 0.4 }), [canSeek]);

    // Resolve isSeeking once currentTime catches up to the seek target, or after
    // a timeout - but only once the slider has actually been released
    // (onChangeEnd), so holding it still mid-drag (without releasing) never gets
    // interrupted/snapped back to the live position. Both checks ride on the
    // currentTime updates themselves rather than a separately armed setTimeout,
    // so the resolve can't be silently cancelled and left stuck.
    useEffect(() => {
        if (!isSeeking || releasedAtRef.current === null) {
            return;
        }

        const closeEnough = Math.abs(currentTime - seekValue) < 0.5;
        const timedOut = Date.now() - releasedAtRef.current > SEEK_RESOLVE_MS;

        if (closeEnough || timedOut) {
            setIsSeeking(false);
            releasedAtRef.current = null;
        }
    }, [currentTime, isSeeking, seekValue]);

    return (
        <CustomPlayerbarSlider
            disabled={!canSeek}
            label={label}
            max={max}
            min={min}
            onChange={handleChange}
            onChangeEnd={handleChangeEnd}
            onClick={handleClick}
            size={6}
            style={sliderStyle}
            value={isSeeking ? seekValue : currentTime}
            w="100%"
        />
    );
};

export const PlayerbarSeekSlider = memo(PlayerbarSeekSliderBase);
PlayerbarSeekSlider.displayName = 'PlayerbarSeekSlider';
