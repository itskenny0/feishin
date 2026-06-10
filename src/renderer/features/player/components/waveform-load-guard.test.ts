// The waveform decodes the whole file to draw peaks. A full-quality local
// blob (offline playback) OOM-kills mobile WebViews, so blob: sources must be
// skipped on native platforms — and ONLY there; desktop keeps its waveform
// even offline.

import { describe, expect, it } from 'vitest';

import { shouldSkipWaveformLoad } from '/@/renderer/features/player/components/waveform-load-guard';

describe('shouldSkipWaveformLoad', () => {
    it('skips blob sources on native platforms', () => {
        expect(shouldSkipWaveformLoad('blob:http://localhost/abc', true)).toBe(true);
    });

    it('allows blob sources on desktop', () => {
        expect(shouldSkipWaveformLoad('blob:http://localhost/abc', false)).toBe(false);
    });

    it('allows remote URLs everywhere (online analysis copy is transcoded/small)', () => {
        expect(shouldSkipWaveformLoad('https://srv/audio/x/universal', true)).toBe(false);
        expect(shouldSkipWaveformLoad('https://srv/audio/x/universal', false)).toBe(false);
    });

    it('treats a missing URL as nothing to skip', () => {
        expect(shouldSkipWaveformLoad(undefined, true)).toBe(false);
    });
});
