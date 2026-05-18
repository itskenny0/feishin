import { TRACKMAP_BIN_COUNT, TRACKMAP_FRAME_SIZE } from '/@/renderer/features/trackmap/types';

/**
 * Root-mean-square energy over a single frame.
 */
export const rms = (frame: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) {
        sum += frame[i] * frame[i];
    }
    return Math.sqrt(sum / frame.length);
};

/**
 * In-place real FFT, radix-2 Cooley-Tukey.
 *
 * Input: real[] (length N, must be a power of 2). Imaginary part is treated
 * as zero. After the call, real[] and imag[] hold the complex output.
 *
 * This is intentionally tiny and not the fastest possible FFT — it's
 * sufficient for N=1024 and runs once per ~23 ms of audio, which
 * comfortably fits inside the worker's time budget. If profiling shows
 * this is the bottleneck, drop in `fft.js`.
 */
export const fftInPlace = (real: Float32Array, imag: Float32Array): void => {
    const n = real.length;
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of 2');

    // Bit-reverse permutation
    let j = 0;
    for (let i = 1; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }

    // Butterflies
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const tableStep = (-2 * Math.PI) / size;
        for (let i = 0; i < n; i += size) {
            for (let k = 0; k < half; k += 1) {
                const angle = tableStep * k;
                const wr = Math.cos(angle);
                const wi = Math.sin(angle);
                const tr = wr * real[i + k + half] - wi * imag[i + k + half];
                const ti = wr * imag[i + k + half] + wi * real[i + k + half];
                real[i + k + half] = real[i + k] - tr;
                imag[i + k + half] = imag[i + k] - ti;
                real[i + k] += tr;
                imag[i + k] += ti;
            }
        }
    }
};

/**
 * Magnitude spectrum of a frame. Reuses scratch buffers caller-side to
 * avoid per-frame allocation across thousands of calls.
 */
export const magnitudeSpectrum = (
    frame: Float32Array,
    scratchReal: Float32Array,
    scratchImag: Float32Array,
    out: Float32Array,
): void => {
    const n = frame.length;
    for (let i = 0; i < n; i += 1) {
        scratchReal[i] = frame[i];
        scratchImag[i] = 0;
    }
    fftInPlace(scratchReal, scratchImag);
    const half = n >> 1;
    for (let i = 0; i < half; i += 1) {
        out[i] = Math.sqrt(scratchReal[i] * scratchReal[i] + scratchImag[i] * scratchImag[i]);
    }
};

/**
 * Half-wave-rectified spectral flux between two magnitude spectra.
 * Returns sum_k max(0, mag[k] - prevMag[k]) — measures positive energy change.
 */
export const spectralFlux = (mag: Float32Array, prevMag: Float32Array): number => {
    let flux = 0;
    for (let i = 0; i < mag.length; i += 1) {
        const diff = mag[i] - prevMag[i];
        if (diff > 0) flux += diff;
    }
    return flux;
};

/**
 * Map sensitivity 0..100 to the standard-deviation multiplier `k` used in
 * the onset threshold `mean(flux) + k * stddev(flux)`. Sensitivity 0 ⇒
 * 2.5σ (only big peaks), 100 ⇒ 0.5σ (loose), 50 ⇒ 1.5σ (default).
 */
export const sensitivityToSigmaK = (sensitivity: number): number => {
    return 2.5 - 2.0 * (sensitivity / 100);
};

/**
 * Compute the intensity hybrid for an entire decoded song.
 *
 * Returns a Float32Array of length TRACKMAP_BIN_COUNT, values in [0, 1].
 * Caller is responsible for transferring the underlying buffer if posting
 * back from a worker.
 */
export const computeIntensity = (
    monoSamples: Float32Array,
    sampleRate: number,
    sensitivity: number,
): Float32Array => {
    const frameSize = TRACKMAP_FRAME_SIZE;
    const totalFrames = Math.floor(monoSamples.length / frameSize);
    if (totalFrames < 2) {
        // Pathological short clip — return all-zeros.
        return new Float32Array(TRACKMAP_BIN_COUNT);
    }

    const frame = new Float32Array(frameSize);
    const scratchReal = new Float32Array(frameSize);
    const scratchImag = new Float32Array(frameSize);
    const mag = new Float32Array(frameSize >> 1);
    const prevMag = new Float32Array(frameSize >> 1);

    const energy = new Float32Array(totalFrames);
    const flux = new Float32Array(totalFrames);

    for (let f = 0; f < totalFrames; f += 1) {
        for (let i = 0; i < frameSize; i += 1) {
            frame[i] = monoSamples[f * frameSize + i];
        }
        energy[f] = rms(frame);
        magnitudeSpectrum(frame, scratchReal, scratchImag, mag);
        flux[f] = f === 0 ? 0 : spectralFlux(mag, prevMag);
        // Remember this frame's magnitude for the next iteration.
        prevMag.set(mag);
    }

    // Onset detection with a rolling window (~1 s = sampleRate/frameSize frames)
    const windowFrames = Math.max(8, Math.floor(sampleRate / frameSize));
    const k = sensitivityToSigmaK(sensitivity);
    const onsets = new Uint8Array(totalFrames);
    for (let f = 0; f < totalFrames; f += 1) {
        const lo = Math.max(0, f - windowFrames);
        const hi = Math.min(totalFrames, f + windowFrames + 1);
        let mean = 0;
        for (let g = lo; g < hi; g += 1) mean += flux[g];
        mean /= hi - lo;
        let variance = 0;
        for (let g = lo; g < hi; g += 1) variance += (flux[g] - mean) ** 2;
        const stddev = Math.sqrt(variance / (hi - lo));
        if (flux[f] > mean + k * stddev) onsets[f] = 1;
    }

    // Bin into TRACKMAP_BIN_COUNT output samples.
    const bins = new Float32Array(TRACKMAP_BIN_COUNT);
    const framesPerBin = totalFrames / TRACKMAP_BIN_COUNT;
    for (let b = 0; b < TRACKMAP_BIN_COUNT; b += 1) {
        const lo = Math.floor(b * framesPerBin);
        const hi = Math.max(lo + 1, Math.floor((b + 1) * framesPerBin));
        let energySum = 0;
        let onsetCount = 0;
        for (let f = lo; f < hi; f += 1) {
            energySum += energy[f];
            onsetCount += onsets[f];
        }
        const meanEnergy = energySum / (hi - lo);
        const onsetDensity = onsetCount / (hi - lo);
        // Hybrid: energy^0.7 modulated by (1 + onsetDensity)
        bins[b] = Math.pow(meanEnergy, 0.7) * (1 + onsetDensity);
    }

    // Normalize against the 95th percentile so a single transient doesn't
    // squash the rest of the curve. Clamp to [0, 1].
    const sorted = Float32Array.from(bins).sort();
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    for (let b = 0; b < TRACKMAP_BIN_COUNT; b += 1) {
        bins[b] = Math.max(0, Math.min(1, bins[b] / p95));
    }

    return bins;
};
