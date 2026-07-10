import type { Song } from '/@/shared/types/domain-types';

import { describe, expect, it } from 'vitest';

import type { CachedMediaBlob } from '../types';

import { isUpToDate, sourceTagFor } from './dedup';

const song = (over: Partial<Song> = {}): Song =>
    ({ container: 'flac', id: 'song1', size: 100, updatedAt: '2026-01-01', ...over }) as Song;

const blob = (over: Partial<CachedMediaBlob> = {}): CachedMediaBlob =>
    ({
        ByteSize: 100,
        Container: 'flac',
        DownloadedAt: 0,
        EntityKeys: ['s:album:a1'],
        Key: 's:song1',
        MimeType: 'audio/flac',
        ServerId: 's',
        SongId: 'song1',
        ...over,
    }) as CachedMediaBlob;

describe('sourceTagFor', () => {
    it('captures size/container/updatedAt, dropping empties', () => {
        expect(sourceTagFor(song())).toEqual({
            container: 'flac',
            size: 100,
            updatedAt: '2026-01-01',
        });
        expect(sourceTagFor(song({ container: null, size: 0, updatedAt: '' }))).toEqual({});
    });
});

describe('isUpToDate', () => {
    it('false when no blob exists', () => {
        expect(isUpToDate(undefined, song())).toBe(false);
    });
    it('true for a legacy row without SourceTag (never re-download)', () => {
        expect(isUpToDate(blob({ SourceTag: undefined }), song())).toBe(true);
    });
    it('true when updatedAt matches', () => {
        expect(isUpToDate(blob({ SourceTag: { updatedAt: '2026-01-01' } }), song())).toBe(true);
    });
    it('false when updatedAt clearly differs', () => {
        expect(isUpToDate(blob({ SourceTag: { updatedAt: '2020-01-01' } }), song())).toBe(false);
    });
    it('falls back to size when updatedAt absent; tolerant within 1% (64 KiB floor)', () => {
        const noUpdated = { updatedAt: '' as never };
        // Identical size → up to date.
        expect(
            isUpToDate(
                blob({ SourceTag: { size: 10_000_000 } }),
                song({ size: 10_000_000, ...noUpdated }),
            ),
        ).toBe(true);
        // 0.5% larger, within the 1% tolerance → up to date (a re-tag).
        expect(
            isUpToDate(
                blob({ SourceTag: { size: 10_000_000 } }),
                song({ size: 10_050_000, ...noUpdated }),
            ),
        ).toBe(true);
        // Halved size, well beyond tolerance → stale, re-download.
        expect(
            isUpToDate(
                blob({ SourceTag: { size: 10_000_000 } }),
                song({ size: 5_000_000, ...noUpdated }),
            ),
        ).toBe(false);
    });
    it('container mismatch marks stale when size/updatedAt inconclusive', () => {
        expect(
            isUpToDate(
                blob({ SourceTag: { container: 'mp3' } }),
                song({ size: 0, updatedAt: '' as never }),
            ),
        ).toBe(false);
    });
    it('ambiguous comparison biases to up-to-date', () => {
        expect(isUpToDate(blob({ SourceTag: {} }), song({ size: 0, updatedAt: '' as never }))).toBe(
            true,
        );
    });
});
