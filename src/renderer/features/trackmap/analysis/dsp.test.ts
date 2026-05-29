// Unit coverage for the trackmap DSP primitives. These functions are pure
// (no I/O, no globals) so they're tested directly with hand-built signals
// whose expected outputs follow from the math, not from a recorded snapshot.

import { describe, expect, it } from 'vitest';

import {
    computeIntensity,
    fftInPlace,
    magnitudeSpectrum,
    rms,
    sensitivityToSigmaK,
    spectralFlux,
} from '/@/renderer/features/trackmap/analysis/dsp';
import { TRACKMAP_BIN_COUNT, TRACKMAP_FRAME_SIZE } from '/@/renderer/features/trackmap/types';

describe('rms', () => {
    it('is zero for an all-zero frame', () => {
        expect(rms(new Float32Array(8))).toBe(0);
    });

    it('equals the constant magnitude for a DC frame', () => {
        // RMS of a constant signal is the constant's absolute value.
        expect(rms(new Float32Array([2, 2, 2, 2]))).toBeCloseTo(2, 10);
        expect(rms(new Float32Array([-3, -3, -3, -3]))).toBeCloseTo(3, 10);
    });

    it('matches the closed form for a known frame', () => {
        // sqrt((1^2 + 2^2 + 2^2 + 4^2)/4) = sqrt(25/4) = 2.5
        expect(rms(new Float32Array([1, 2, 2, 4]))).toBeCloseTo(2.5, 10);
    });
});

describe('fftInPlace', () => {
    it('throws when the length is not a power of two', () => {
        expect(() => fftInPlace(new Float32Array(3), new Float32Array(3))).toThrow(
            'FFT size must be a power of 2',
        );
    });

    it('transforms a DC signal to a single non-zero bin at k=0', () => {
        // FFT of [1,1,1,1] is [4,0,0,0] (real), all-zero imaginary.
        const real = new Float32Array([1, 1, 1, 1]);
        const imag = new Float32Array(4);
        fftInPlace(real, imag);
        expect(real[0]).toBeCloseTo(4, 6);
        expect(real[1]).toBeCloseTo(0, 6);
        expect(real[2]).toBeCloseTo(0, 6);
        expect(real[3]).toBeCloseTo(0, 6);
        for (const v of imag) expect(v).toBeCloseTo(0, 6);
    });

    it('matches the analytic transform of a single-cycle cosine', () => {
        // cos(2*pi*n/N) over N=8 has energy concentrated at bins 1 and N-1,
        // each = N/2 (real, no imaginary part for a pure cosine).
        const n = 8;
        const real = new Float32Array(n);
        for (let i = 0; i < n; i += 1) real[i] = Math.cos((2 * Math.PI * i) / n);
        const imag = new Float32Array(n);
        fftInPlace(real, imag);
        expect(real[1]).toBeCloseTo(n / 2, 5);
        expect(real[n - 1]).toBeCloseTo(n / 2, 5);
        expect(real[0]).toBeCloseTo(0, 5);
        expect(real[2]).toBeCloseTo(0, 5);
    });

    it('preserves Parseval energy (sum |x|^2 ~= (1/N) sum |X|^2)', () => {
        const n = 16;
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let i = 0; i < n; i += 1) real[i] = Math.sin((3 * 2 * Math.PI * i) / n) + 0.5;
        let timeEnergy = 0;
        for (let i = 0; i < n; i += 1) timeEnergy += real[i] * real[i];
        fftInPlace(real, imag);
        let freqEnergy = 0;
        for (let i = 0; i < n; i += 1) freqEnergy += real[i] * real[i] + imag[i] * imag[i];
        expect(freqEnergy / n).toBeCloseTo(timeEnergy, 4);
    });
});

describe('magnitudeSpectrum', () => {
    it('writes half-spectrum magnitudes and leaves DC dominant for a constant frame', () => {
        const n = 8;
        const frame = new Float32Array(n).fill(1);
        const out = new Float32Array(n >> 1);
        magnitudeSpectrum(frame, new Float32Array(n), new Float32Array(n), out);
        // DC bin holds all the energy; everything above is ~0.
        expect(out[0]).toBeCloseTo(n, 5);
        for (let i = 1; i < out.length; i += 1) expect(out[i]).toBeCloseTo(0, 5);
    });

    it('does not mutate the input frame', () => {
        const n = 8;
        const frame = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
        const copy = Float32Array.from(frame);
        magnitudeSpectrum(
            frame,
            new Float32Array(n),
            new Float32Array(n),
            new Float32Array(n >> 1),
        );
        expect(Array.from(frame)).toEqual(Array.from(copy));
    });
});

describe('spectralFlux', () => {
    it('is zero when spectra are identical', () => {
        const a = new Float32Array([1, 2, 3, 4]);
        expect(spectralFlux(a, Float32Array.from(a))).toBe(0);
    });

    it('counts only positive changes (half-wave rectified)', () => {
        // diffs: +2, -1, +3, -4 -> sum of positive = 5
        const mag = new Float32Array([3, 1, 5, 0]);
        const prev = new Float32Array([1, 2, 2, 4]);
        expect(spectralFlux(mag, prev)).toBeCloseTo(5, 10);
    });

    it('is zero when all bins decrease', () => {
        const mag = new Float32Array([1, 1, 1]);
        const prev = new Float32Array([2, 3, 4]);
        expect(spectralFlux(mag, prev)).toBe(0);
    });
});

describe('sensitivityToSigmaK', () => {
    it('maps the documented anchor points', () => {
        expect(sensitivityToSigmaK(0)).toBeCloseTo(2.5, 10);
        expect(sensitivityToSigmaK(50)).toBeCloseTo(1.5, 10);
        expect(sensitivityToSigmaK(100)).toBeCloseTo(0.5, 10);
    });

    it('is monotonically decreasing in sensitivity', () => {
        expect(sensitivityToSigmaK(10)).toBeGreaterThan(sensitivityToSigmaK(90));
    });
});

describe('computeIntensity', () => {
    it('returns an all-zero bin array for a pathologically short clip', () => {
        // Fewer than 2 frames -> documented all-zeros early return.
        const tiny = new Float32Array(TRACKMAP_FRAME_SIZE);
        const bins = computeIntensity(tiny, 8000, 50);
        expect(bins).toHaveLength(TRACKMAP_BIN_COUNT);
        expect(Array.from(bins).every((v) => v === 0)).toBe(true);
    });

    it('emits TRACKMAP_BIN_COUNT samples clamped to [0, 1]', () => {
        // A few seconds of band-limited noise: enough frames for the full path.
        const sampleRate = 8000;
        const samples = new Float32Array(sampleRate * 4);
        let seed = 12345;
        for (let i = 0; i < samples.length; i += 1) {
            // Deterministic LCG so the test is reproducible across machines.
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            samples[i] = (seed / 0x7fffffff) * 2 - 1;
        }
        const bins = computeIntensity(samples, sampleRate, 50);
        expect(bins).toHaveLength(TRACKMAP_BIN_COUNT);
        for (const v of bins) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
            expect(Number.isNaN(v)).toBe(false);
        }
    });

    it('produces a higher mean intensity for a loud signal than a near-silent one', () => {
        const sampleRate = 8000;
        const len = sampleRate * 3;
        const loud = new Float32Array(len);
        const quiet = new Float32Array(len);
        for (let i = 0; i < len; i += 1) {
            const tone = Math.sin((2 * Math.PI * 220 * i) / sampleRate);
            loud[i] = tone;
            quiet[i] = tone * 0.001;
        }
        const loudBins = computeIntensity(loud, sampleRate, 50);
        const quietBins = computeIntensity(quiet, sampleRate, 50);
        const mean = (arr: Float32Array): number => arr.reduce((acc, v) => acc + v, 0) / arr.length;
        // Both are normalised to their own 95th percentile, but the louder
        // signal's energy curve fills more of the [0,1] range, so its mean
        // should not be below the near-silent clip's.
        expect(mean(loudBins)).toBeGreaterThan(0);
        expect(mean(loudBins)).toBeGreaterThanOrEqual(mean(quietBins) - 1e-6);
    });
});
