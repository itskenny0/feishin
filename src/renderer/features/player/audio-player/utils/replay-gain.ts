// Library-wide loudness normalization (ReplayGain) gain math.
//
// This is the single source of truth used by the web-audio engine and the
// wavesurfer engine to translate a song's ReplayGain track/album tags into a
// LINEAR gain multiplier applied on a Web Audio GainNode. The MPV engine does
// the equivalent math natively (mpv `replaygain` / `replaygain-preamp` /
// `replaygain-clip` / `replaygain-fallback`); keeping the JS math aligned with
// mpv's semantics is what makes loudness consistent across BOTH engines.
//
// Key library-wide-consistency behaviours:
//   - track vs album mode, each falling back to the other tag when its own is
//     missing (so an album-tagged-only file still normalizes in track mode and
//     vice-versa);
//   - a configurable FALLBACK gain (dB) applied to tracks that have NO tags at
//     all, so untagged songs aren't wildly louder/quieter than tagged ones —
//     this is the common gap in mixed libraries;
//   - a preamp (dB) added on top;
//   - peak-aware clipping prevention: never boost past the point where the
//     stored sample peak would exceed full scale.

import type { QueueSong } from '/@/shared/types/domain-types';

export type ReplayGainMode = 'album' | 'no' | 'track';

export interface ReplayGainSettings {
    /** When true, attenuate the result so peak * gain never exceeds 1.0. */
    replayGainClip?: boolean;
    /**
     * Gain (dB) to apply when the track carries NO ReplayGain tags at all.
     * `undefined` (or NaN) means "leave untagged tracks untouched" (gain 1.0).
     * A finite value — including 0 — is treated as an explicit fallback so that
     * untagged tracks are normalized toward the rest of the library.
     */
    replayGainFallbackDB?: number;
    replayGainMode?: ReplayGainMode;
    /** Preamp (dB) added on top of the resolved track/album/fallback gain. */
    replayGainPreampDB?: number;
}

const UNITY_GAIN = 1;

/** dB → linear amplitude multiplier. */
export const dbToLinear = (db: number): number => 10 ** (db / 20);

/**
 * Resolve the gain (dB) and peak for a song under the given mode, applying the
 * cross-tag fallback (track↔album) and finally the untagged fallback dB.
 *
 * Returns `gainDb: undefined` only when the mode is active, the song is
 * untagged, AND no usable fallback was configured — the caller then leaves the
 * signal at unity.
 */
export const resolveReplayGainValues = (
    song: Pick<QueueSong, 'gain' | 'peak'> | undefined,
    settings: ReplayGainSettings,
): { gainDb: number | undefined; peak: number } => {
    const mode = settings.replayGainMode ?? 'no';

    if (mode === 'no') {
        return { gainDb: undefined, peak: 1 };
    }

    let gainDb: number | undefined;
    let peak: number | undefined;

    if (mode === 'track') {
        gainDb = song?.gain?.track ?? song?.gain?.album;
        peak = song?.peak?.track ?? song?.peak?.album;
    } else {
        gainDb = song?.gain?.album ?? song?.gain?.track;
        peak = song?.peak?.album ?? song?.peak?.track;
    }

    // Untagged track: fall back to the configured default so it is normalized
    // toward the rest of the library instead of playing at raw file loudness.
    if (gainDb === undefined || Number.isNaN(gainDb)) {
        const fallback = settings.replayGainFallbackDB;
        gainDb =
            fallback === undefined || Number.isNaN(fallback) || !Number.isFinite(fallback)
                ? undefined
                : fallback;
    }

    // A valid peak must be a finite positive number; otherwise we can't reason
    // about clipping, so we treat it as full-scale (1.0) which makes the
    // peak-aware limiter a no-op for that track.
    if (peak === undefined || !Number.isFinite(peak) || peak <= 0) {
        peak = 1;
    }

    return { gainDb, peak };
};

/**
 * Compute the LINEAR gain multiplier for a song. Always returns a finite,
 * non-negative number; defaults to unity (1.0) whenever normalization is off,
 * the song is untagged with no fallback, or the math would otherwise produce a
 * non-finite value.
 *
 * https://wiki.hydrogenaud.io/index.php?title=ReplayGain_1.0_specification
 */
export const calculateReplayGain = (
    song: Pick<QueueSong, 'gain' | 'peak'> | undefined,
    settings: ReplayGainSettings,
): number => {
    const { gainDb, peak } = resolveReplayGainValues(song, settings);

    if (gainDb === undefined) {
        return UNITY_GAIN;
    }

    const preAmp = Number.isFinite(settings.replayGainPreampDB)
        ? (settings.replayGainPreampDB as number)
        : 0;

    let gain = dbToLinear(gainDb + preAmp);

    // Guard against a NaN/Infinity poisoning the whole audio graph (a single
    // bad GainNode value mutes/destroys playback until reload).
    if (!Number.isFinite(gain)) {
        return UNITY_GAIN;
    }

    // Peak-aware clipping prevention: never let peak * gain exceed full scale.
    if (settings.replayGainClip) {
        gain = Math.min(gain, 1 / peak);
    }

    // Gain must never go negative (would invert phase / be nonsensical).
    return Math.max(0, gain);
};
