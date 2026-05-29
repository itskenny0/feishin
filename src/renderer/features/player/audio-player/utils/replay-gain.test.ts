// Unit tests for the library-wide ReplayGain (loudness normalization) math.
//
// Covers: track vs album mode + cross-tag fallback, preamp, the untagged
// fallback dB (the library-wide-consistency feature), peak-aware clipping, and
// the defensive guards (NaN / non-finite / negative).

import { describe, expect, it } from 'vitest';

import {
    calculateReplayGain,
    dbToLinear,
    resolveReplayGainValues,
} from '/@/renderer/features/player/audio-player/utils/replay-gain';

// Minimal QueueSong-shaped fixtures (only gain/peak are read).
const song = (
    gain: null | { album?: number; track?: number },
    peak?: null | { album?: number; track?: number },
) =>
    ({
        gain: gain ?? null,
        peak: peak ?? null,
    }) as any;

// Tolerance for floating-point dB→linear comparisons.
const closeTo = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe('dbToLinear', () => {
    it('maps 0 dB to unity', () => {
        expect(dbToLinear(0)).toBe(1);
    });

    it('maps -6 dB to ~0.501', () => {
        expect(closeTo(dbToLinear(-6), 0.501187)).toBe(true);
    });

    it('maps +6 dB to ~1.995', () => {
        expect(closeTo(dbToLinear(6), 1.995262)).toBe(true);
    });
});

describe('calculateReplayGain — mode off', () => {
    it('returns unity when mode is "no" regardless of tags', () => {
        expect(
            calculateReplayGain(song({ track: -10 }, { track: 0.9 }), { replayGainMode: 'no' }),
        ).toBe(1);
    });

    it('returns unity when mode is undefined', () => {
        expect(calculateReplayGain(song({ track: -10 }), {})).toBe(1);
    });
});

describe('calculateReplayGain — track mode', () => {
    it('uses the track gain', () => {
        const g = calculateReplayGain(song({ album: -3, track: -8 }), { replayGainMode: 'track' });
        expect(closeTo(g, dbToLinear(-8))).toBe(true);
    });

    it('falls back to album gain when track gain is missing', () => {
        const g = calculateReplayGain(song({ album: -3 }), { replayGainMode: 'track' });
        expect(closeTo(g, dbToLinear(-3))).toBe(true);
    });
});

describe('calculateReplayGain — album mode', () => {
    it('uses the album gain', () => {
        const g = calculateReplayGain(song({ album: -4, track: -8 }), { replayGainMode: 'album' });
        expect(closeTo(g, dbToLinear(-4))).toBe(true);
    });

    it('falls back to track gain when album gain is missing', () => {
        const g = calculateReplayGain(song({ track: -8 }), { replayGainMode: 'album' });
        expect(closeTo(g, dbToLinear(-8))).toBe(true);
    });
});

describe('calculateReplayGain — preamp', () => {
    it('adds preamp dB to the resolved gain', () => {
        const g = calculateReplayGain(song({ track: -8 }), {
            replayGainMode: 'track',
            replayGainPreampDB: 3,
        });
        expect(closeTo(g, dbToLinear(-5))).toBe(true);
    });

    it('applies preamp to the fallback gain for untagged tracks', () => {
        const g = calculateReplayGain(song(null), {
            replayGainFallbackDB: -6,
            replayGainMode: 'track',
            replayGainPreampDB: 2,
        });
        expect(closeTo(g, dbToLinear(-4))).toBe(true);
    });
});

describe('calculateReplayGain — untagged fallback (library-wide consistency)', () => {
    it('applies the configured fallback dB to an untagged track', () => {
        const g = calculateReplayGain(song(null), {
            replayGainFallbackDB: -6,
            replayGainMode: 'track',
        });
        expect(closeTo(g, dbToLinear(-6))).toBe(true);
    });

    it('treats an explicit 0 dB fallback as a real fallback (unity, not "no fallback")', () => {
        const g = calculateReplayGain(song(null), {
            replayGainFallbackDB: 0,
            replayGainMode: 'track',
        });
        expect(g).toBe(1);
    });

    it('leaves untagged tracks at unity when no fallback is configured', () => {
        expect(calculateReplayGain(song(null), { replayGainMode: 'track' })).toBe(1);
    });

    it('ignores a NaN fallback (leaves untagged tracks at unity)', () => {
        expect(
            calculateReplayGain(song(null), {
                replayGainFallbackDB: NaN,
                replayGainMode: 'track',
            }),
        ).toBe(1);
    });

    it('does NOT apply the fallback when the track is tagged', () => {
        const g = calculateReplayGain(song({ track: -10 }), {
            replayGainFallbackDB: -6,
            replayGainMode: 'track',
        });
        expect(closeTo(g, dbToLinear(-10))).toBe(true);
    });
});

describe('calculateReplayGain — peak-aware clipping prevention', () => {
    it('clamps a boosting gain so peak * gain never exceeds full scale', () => {
        // +6 dB boost (~1.995) on a track that already peaks at 0.8 would clip.
        const g = calculateReplayGain(song({ track: 6 }, { track: 0.8 }), {
            replayGainClip: true,
            replayGainMode: 'track',
        });
        expect(closeTo(g, 1 / 0.8)).toBe(true);
        expect(g * 0.8).toBeLessThanOrEqual(1 + 1e-9);
    });

    it('does not clamp when the gain keeps peak below full scale', () => {
        // -6 dB attenuation on a peak of 0.9 — no clipping risk.
        const g = calculateReplayGain(song({ track: -6 }, { track: 0.9 }), {
            replayGainClip: true,
            replayGainMode: 'track',
        });
        expect(closeTo(g, dbToLinear(-6))).toBe(true);
    });

    it('does not clamp when clipping prevention is disabled even if it would clip', () => {
        const g = calculateReplayGain(song({ track: 6 }, { track: 0.8 }), {
            replayGainClip: false,
            replayGainMode: 'track',
        });
        expect(closeTo(g, dbToLinear(6))).toBe(true);
    });

    it('treats a missing peak as full scale (limiter is a no-op)', () => {
        const g = calculateReplayGain(song({ track: 3 }, null), {
            replayGainClip: true,
            replayGainMode: 'track',
        });
        // min(dbToLinear(3), 1/1) = 1 (the boost is clamped to unity peak)
        expect(g).toBe(1);
    });
});

describe('calculateReplayGain — defensive guards', () => {
    it('ignores a non-finite preamp (treats it as 0 dB) instead of poisoning the gain', () => {
        const g = calculateReplayGain(song({ track: -8 }), {
            replayGainMode: 'track',
            replayGainPreampDB: Infinity,
        });
        // Infinity preamp is discarded -> gain is just the -8 dB track value.
        expect(closeTo(g, dbToLinear(-8))).toBe(true);
    });

    it('guards against a non-finite resolved gain (returns unity)', () => {
        // A pathological track gain of +Infinity dB would produce a non-finite
        // linear gain; the limiter/guard must keep it from poisoning the graph.
        const g = calculateReplayGain(song({ track: Infinity }), { replayGainMode: 'track' });
        expect(g).toBe(1);
    });

    it('never returns a negative gain', () => {
        const g = calculateReplayGain(song({ track: -200 }), {
            replayGainMode: 'track',
        });
        expect(g).toBeGreaterThanOrEqual(0);
    });

    it('handles an undefined song (no gain/peak) as untagged', () => {
        expect(
            calculateReplayGain(undefined, { replayGainFallbackDB: -6, replayGainMode: 'track' }),
        ).toBeCloseTo(dbToLinear(-6));
    });
});

describe('resolveReplayGainValues', () => {
    it('reports the resolved dB and peak under track mode', () => {
        const { gainDb, peak } = resolveReplayGainValues(song({ track: -7 }, { track: 0.95 }), {
            replayGainMode: 'track',
        });
        expect(gainDb).toBe(-7);
        expect(peak).toBe(0.95);
    });

    it('reports gainDb undefined when off', () => {
        const { gainDb } = resolveReplayGainValues(song({ track: -7 }), { replayGainMode: 'no' });
        expect(gainDb).toBeUndefined();
    });

    it('normalizes a non-positive peak to 1', () => {
        const { peak } = resolveReplayGainValues(song({ track: -7 }, { track: 0 }), {
            replayGainMode: 'track',
        });
        expect(peak).toBe(1);
    });
});
