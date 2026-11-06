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

const pathSegments = (path?: null | string): string[] =>
    path ? path.split(/[/\\]/).filter(Boolean) : [];

export const albumFolderFromSongPath = (path?: null | string): null | string => {
    const segments = pathSegments(path);
    const parent = segments.at(-2) ?? null;
    if (parent && DISC_FOLDER_RE.test(parent)) {
        // Walk up past the disc folder if there's another level above.
        return segments.at(-3) ?? parent;
    }
    return parent;
};

/** File or folder name at the end of a POSIX or Windows path, ignoring trailing separators. */
export const lastPathSegment = (path?: null | string): null | string =>
    pathSegments(path).at(-1) ?? null;

/** Name of the folder containing the file at the end of `path` (e.g. a song's folder). */
export const parentPathSegment = (path?: null | string): null | string =>
    pathSegments(path).at(-2) ?? null;
