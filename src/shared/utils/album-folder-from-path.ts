/**
 * Derive the album folder name from a song's filesystem path.
 *
 * Normally this is the immediate parent directory:
 *   /Music/Artist/Album/01 - Track.flac    →  "Album"
 *
 * For multi-disc layouts the immediate parent is a disc folder (`Disc 1`,
 * `CD2`, `Vol. 3`, …) which isn't the album name. In that case we walk one
 * level higher:
 *   /Music/Artist/Album/Disc 1/01.flac     →  "Album"
 *   /Music/Artist/Album/CD2/05 - Foo.flac  →  "Album"
 *
 * Returns null when the path is missing or too shallow to extract anything
 * meaningful (a bare filename or a one-segment path).
 *
 * Handles both POSIX (`/`) and Windows (`\\`) separators.
 */
const DISC_FOLDER_RE = /^(?:disc|cd|disk|vol(?:ume)?\.?)\s*[\d]+$/i;

export const albumFolderFromSongPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length < 2) return null;
    const parent = segments[segments.length - 2] ?? null;
    if (parent && DISC_FOLDER_RE.test(parent)) {
        // Walk up past the disc folder if there's another level above.
        return segments[segments.length - 3] ?? parent;
    }
    return parent;
};
