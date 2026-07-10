// Dedup + change detection for offline downloads. The single source of truth
// for "do we already have a current copy of this song?" — used by the manager
// before resolving/fetching each song, and by redundancy accounting.

import type { Song } from '/@/shared/types/domain-types';

import type { CachedMediaBlob, OfflineSourceTag } from '../types';

// Size comparisons tolerate tiny remux/tag deltas so a byte-identical re-tag
// doesn't force a re-download. 1% or 64 KiB, whichever is larger.
const SIZE_TOLERANCE_FRAC = 0.01;
const SIZE_TOLERANCE_MIN = 64 * 1024;

/** Freshness fingerprint for a song, dropping empty/zero fields. */
export const sourceTagFor = (song: Song): OfflineSourceTag => {
    const tag: OfflineSourceTag = {};
    if (song.container) tag.container = song.container;
    if (typeof song.size === 'number' && song.size > 0) tag.size = song.size;
    if (song.updatedAt) tag.updatedAt = song.updatedAt;
    return tag;
};

const sizeWithinTolerance = (a: number, b: number): boolean => {
    const tol = Math.max(SIZE_TOLERANCE_MIN, Math.max(a, b) * SIZE_TOLERANCE_FRAC);
    return Math.abs(a - b) <= tol;
};

/**
 * True when a stored blob is a current copy of `song` and must NOT be
 * re-downloaded. Bias is always toward `true` (don't re-download) when the
 * comparison is inconclusive.
 *
 * - No blob → false (must download).
 * - Legacy blob (no SourceTag) → true (we have no basis to claim it changed).
 * - updatedAt present on both → authoritative equality check.
 * - else size present on both → tolerant equality.
 * - else container present on both → equality.
 * - else → true.
 */
export const isUpToDate = (existing: CachedMediaBlob | undefined, song: Song): boolean => {
    if (!existing) return false;
    const tag = existing.SourceTag;
    if (!tag) return true;

    const liveTag = sourceTagFor(song);

    if (tag.updatedAt && liveTag.updatedAt) {
        return tag.updatedAt === liveTag.updatedAt;
    }
    if (typeof tag.size === 'number' && typeof liveTag.size === 'number') {
        return sizeWithinTolerance(tag.size, liveTag.size);
    }
    if (tag.container && liveTag.container) {
        return tag.container === liveTag.container;
    }
    return true;
};
