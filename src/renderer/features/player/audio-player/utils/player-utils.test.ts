// Unit tests for the volume-curve helper used by the web/wavesurfer engines.
//
// convertToLogVolume maps a linear 0..1 fader position to a perceptual (square)
// curve so the slider feels even across its travel.

import { describe, expect, it } from 'vitest';

import { convertToLogVolume } from '/@/renderer/features/player/audio-player/utils/player-utils';

describe('convertToLogVolume', () => {
    it('maps the endpoints 0 and 1 to themselves', () => {
        expect(convertToLogVolume(0)).toBe(0);
        expect(convertToLogVolume(1)).toBe(1);
    });

    it('squares the input (0.5 → 0.25)', () => {
        expect(convertToLogVolume(0.5)).toBe(0.25);
        expect(convertToLogVolume(0.25)).toBeCloseTo(0.0625, 12);
        expect(convertToLogVolume(0.8)).toBeCloseTo(0.64, 12);
    });

    it('is monotonically increasing across the fader range', () => {
        let prev = -1;
        for (let v = 0; v <= 1.0001; v += 0.1) {
            const out = convertToLogVolume(v);
            expect(out).toBeGreaterThanOrEqual(prev);
            prev = out;
        }
    });
});
