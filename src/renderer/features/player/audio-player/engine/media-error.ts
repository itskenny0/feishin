// Helpers for diagnosing HTML5 media errors. The browser's `MediaError` object
// stringifies to `{}` (its `code`/`message` are non-enumerable), so logging the
// raw object — as the player engine used to — produced an unactionable
// `{"error":{}}` in shipped logs. These turn it into something triageable.

const MEDIA_ERROR_LABELS: Record<number, string> = {
    1: 'ABORTED', // MEDIA_ERR_ABORTED — fetch aborted by the user/app
    2: 'NETWORK', // MEDIA_ERR_NETWORK — download failed after the resource was usable
    3: 'DECODE', // MEDIA_ERR_DECODE — corruption or unsupported features
    4: 'SRC_NOT_SUPPORTED', // MEDIA_ERR_SRC_NOT_SUPPORTED — format/URL not playable
};

/** Human-readable name for a `MediaError.code`. */
export const mediaErrorLabel = (code: number | undefined): string => {
    if (code === undefined) return 'UNKNOWN';
    return MEDIA_ERROR_LABELS[code] ?? `UNKNOWN(${code})`;
};

/**
 * A log-safe view of a media source URL: host + path only, with the query
 * string dropped so the Jellyfin/Subsonic `apiKey` never lands in the shipped
 * logs. Returns `undefined` for an empty/unparseable/data: URL.
 */
export const redactMediaSrc = (src: string | undefined): string | undefined => {
    if (!src || src.startsWith('data:')) return undefined;
    try {
        const u = new URL(src);
        return `${u.host}${u.pathname}`;
    } catch {
        return undefined;
    }
};
