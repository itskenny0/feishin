import { describe, expect, it } from 'vitest';

import { blurHashesDiffer } from '/@/shared/utils/blurhash';

// Real Jellyfin pairs (a track's own Primary image vs. its album's).
const SAME_ART = 'eHR{.2?b-q%Nxv?Fj]S5a$s;^-kDR%ocR%.9t6xCadR%%2n~IokAoJ';
// Same artwork from another source file: one AC component one quantization
// step away.
const SAME_ART_REENCODED = 'eHR{.2?b-q%Nxv?Fj[S5a$s;^-kDR%ocR%.9t6xCadR%%2n~IokAoJ';
const TRACK_ART = 'eYDcL2~qxuNGIUE1D%IUayoL9ZIUxaxbt7W;s:t7bIof%MozRjRkf6';
const ALBUM_ART = 'e56RM@tRIURj-=%39WIUM{t7xvbE?dozRiWFM_t7ISM{RkM_xuof%O';

describe('blurHashesDiffer', () => {
    it('is false for identical hashes', () => {
        expect(blurHashesDiffer(SAME_ART, SAME_ART)).toBe(false);
    });

    it('is false for the same artwork re-encoded (quantization noise)', () => {
        expect(blurHashesDiffer(SAME_ART, SAME_ART_REENCODED)).toBe(false);
    });

    it('is true for genuinely different artwork', () => {
        expect(blurHashesDiffer(TRACK_ART, ALBUM_ART)).toBe(true);
    });

    it('is true when the component grids differ', () => {
        // 'L' = 4x3 components, 'e' = 5x5.
        expect(blurHashesDiffer('LEHV6nWB2yk8pyo0adR*.7kCMdnj', SAME_ART)).toBe(true);
    });

    it('is false when either hash is missing or malformed', () => {
        expect(blurHashesDiffer(undefined, SAME_ART)).toBe(false);
        expect(blurHashesDiffer(SAME_ART, null)).toBe(false);
        expect(blurHashesDiffer('', SAME_ART)).toBe(false);
        expect(blurHashesDiffer('eHR{.2', SAME_ART)).toBe(false);
        expect(blurHashesDiffer(SAME_ART.replace('{', ' '), TRACK_ART)).toBe(false);
    });
});
