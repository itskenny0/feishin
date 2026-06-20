import { describe, expect, it } from 'vitest';

import { mediaErrorLabel, redactMediaSrc } from './media-error';

describe('mediaErrorLabel', () => {
    it('names every standard MediaError code', () => {
        expect(mediaErrorLabel(1)).toBe('ABORTED');
        expect(mediaErrorLabel(2)).toBe('NETWORK');
        expect(mediaErrorLabel(3)).toBe('DECODE');
        expect(mediaErrorLabel(4)).toBe('SRC_NOT_SUPPORTED');
    });

    it('handles missing / unknown codes', () => {
        expect(mediaErrorLabel(undefined)).toBe('UNKNOWN');
        expect(mediaErrorLabel(99)).toBe('UNKNOWN(99)');
    });
});

describe('redactMediaSrc', () => {
    it('keeps host + path but drops the query (apiKey)', () => {
        expect(
            redactMediaSrc('http://jelly.example:8096/Items/abc/Download?apiKey=SECRET&x=1'),
        ).toBe('jelly.example:8096/Items/abc/Download');
    });

    it('returns undefined for empty / data: / unparseable URLs', () => {
        expect(redactMediaSrc(undefined)).toBeUndefined();
        expect(redactMediaSrc('')).toBeUndefined();
        expect(redactMediaSrc('data:audio/mp3;base64,AAAA')).toBeUndefined();
        expect(redactMediaSrc('not a url')).toBeUndefined();
    });
});
