/**
 * Some songs come back from the server with `releaseYear === 1` (or another
 * implausible value) when the source date was empty/default-initialised.
 * Rendering that literal '1' next to a track title looks like a bug, so we
 * gate every release-year display through this predicate.
 */
export const isPlausibleReleaseYear = (value: null | number | undefined): value is number => {
    if (typeof value !== 'number') return false;
    if (!Number.isInteger(value)) return false;
    return value >= 1000 && value <= 9999;
};
