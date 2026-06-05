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

// Wrapped in React.memo so a parent re-render (e.g. PlayerbarSlider
// reconciling on a song/source change) doesn't reconcile this comparatively
// expensive Mantine slider — it only re-renders when its own max/min props
// change or its own (now ~20fps-gated) position subscription emits.
const PlayerbarSeekSliderBase = ({ max, min }: PlayerbarSeekSliderProps) => {
    const [isSeeking, setIsSeeking] = useState(false);
    const [seekValue, setSeekValue] = useState(0);
    const source = useActivePlayerSource();
    const localTime = usePlayerTimestamp();
    const remotePositionMs = useRemoteInterpolatedPositionMs();
    const currentTime = source.mode === 'remote' ? remotePositionMs / 1000 : localTime;
    const seekTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastSeekValueRef = useRef<null | number>(null);

    const canSeek = useTransportEnabled('Seek');
    const { mediaSeekToTimestamp } = usePlayer();

    // All of the slider's props except `value` are hoisted to stable
    // identities (memoized callbacks / style / label fn) so that — together
    // with CustomPlayerbarSlider being React.memo'd — only the per-tick
    // `value` change forces a slider re-render, instead of every callback +
    // the inline style object being rebuilt on each ~20fps position emit.
    const label = useCallback((value: number) => formatDuration(value * 1000), []);

    const handleChange = useCallback((e: number) => {
        // Cancel any pending timeout if user starts seeking again
        if (seekTimeoutRef.current) {
            clearTimeout(seekTimeoutRef.current);
            seekTimeoutRef.current = null;
        }
        setIsSeeking(true);
        setSeekValue(e);
    }, []);

    const handleChangeEnd = useCallback(
        (e: number) => {
            setSeekValue(e);
            lastSeekValueRef.current = e;
            mediaSeekToTimestamp(e);

            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
            }

            // Keep isSeeking true to prevent slider from snapping back.
            // The useEffect will detect when currentTime catches up and clear isSeeking.
            // Also set a fallback timeout to clear isSeeking after a max delay
            // in case the seek doesn't complete (e.g., network issues).
            //
            // Bumped from 1000ms → 5000ms: transcoded streams (high-bit-
            // rate FLAC, radio re-encoding) routinely take 2-4s to land
            // a seek; the previous 1s fallback snapped the slider back
            // to the old position before the seek completed, making the
            // user think the seek didn't take.
            seekTimeoutRef.current = setTimeout(() => {
                setIsSeeking(false);
                lastSeekValueRef.current = null;
                seekTimeoutRef.current = null;
            }, 5000);
        },
        [mediaSeekToTimestamp],
    );

    const handleClick = useCallback((e?: { stopPropagation: () => void }) => {
        e?.stopPropagation();
    }, []);

    const sliderStyle = useMemo(() => ({ opacity: canSeek ? undefined : 0.4 }), [canSeek]);

    // Sync isSeeking state when currentTime catches up to seek value
    useEffect(() => {
        if (isSeeking && lastSeekValueRef.current !== null) {
            const timeDiff = Math.abs(currentTime - lastSeekValueRef.current);
            if (timeDiff < 0.5) {
                setIsSeeking(false);
                lastSeekValueRef.current = null;
                if (seekTimeoutRef.current) {
                    clearTimeout(seekTimeoutRef.current);
                    seekTimeoutRef.current = null;
                }
            }
        }
    }, [currentTime, isSeeking]);

    useEffect(() => {
        return () => {
            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
            }
        };
    }, []);

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
            value={
                isSeeking
                    ? seekValue
                    : lastSeekValueRef.current !== null &&
                        Math.abs(currentTime - lastSeekValueRef.current) > 0.5
                      ? lastSeekValueRef.current
                      : currentTime
            }
            w="100%"
        />
    );
};

export const PlayerbarSeekSlider = memo(PlayerbarSeekSliderBase);
PlayerbarSeekSlider.displayName = 'PlayerbarSeekSlider';
