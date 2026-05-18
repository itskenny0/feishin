/**
 * Number of intensity samples emitted per song. Tuned for a 4-minute
 * track to give ~one sample per second — small enough that the cache
 * blob is <1 KB, large enough to read distinct verse / chorus / bridge
 * sections on the canvas.
 */
export const TRACKMAP_BIN_COUNT = 256;

/**
 * Per-frame size for the DSP windowing pass. 1024 samples at 44.1 kHz
 * is ~23 ms — a standard short-time window that's small enough for
 * onset timing and large enough for usable FFT resolution.
 */
export const TRACKMAP_FRAME_SIZE = 1024;

/** Format version of the cached trackmap blob. Bump to force re-analysis. */
export const TRACKMAP_DATA_VERSION = 1;

export interface TrackmapData {
    /** Length = TRACKMAP_BIN_COUNT. Values in [0, 1]. */
    bins: Float32Array;
    /** Date.now() at the time of analysis — for debugging only. */
    computedAt: number;
    /** From the decoded AudioBuffer; may differ from the song metadata duration. */
    durationMs: number;
    /** Format version — see TRACKMAP_DATA_VERSION. */
    version: number;
}

export type TrackmapStatus = 'error' | 'idle' | 'loading' | 'ready';
