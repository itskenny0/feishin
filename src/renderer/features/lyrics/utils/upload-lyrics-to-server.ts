import { createAuthHeader } from '/@/renderer/api/jellyfin/jellyfin-api';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { ServerListItemWithCredential } from '/@/shared/types/domain-types';
import { FullLyricsMetadata, SynchronizedLyricsArray } from '/@/shared/types/domain-types';

/**
 * Format synchronized lyrics as an LRC file body.
 * `[mm:ss.xx]text\n` per line, ordered ascending.
 */
const formatLrc = (synced: SynchronizedLyricsArray): string => {
    return synced
        .slice()
        .sort((a, b) => a[0] - b[0])
        .map(([timeMs, text]) => {
            const ms = Math.max(0, Math.round(timeMs));
            const totalSeconds = ms / 1000;
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = Math.floor(totalSeconds % 60);
            const hundredths = Math.floor((ms % 1000) / 10);
            const mm = String(minutes).padStart(2, '0');
            const ss = String(seconds).padStart(2, '0');
            const xx = String(hundredths).padStart(2, '0');
            return `[${mm}:${ss}.${xx}]${text}`;
        })
        .join('\n');
};

interface UploadArgs {
    itemId: string;
    lyrics: FullLyricsMetadata;
    server: ServerListItemWithCredential;
}

// Cap upload size so a pathological synced-lyrics array doesn't blow up the
// server. 100 KiB comfortably covers a 30-minute progressive-rock LRC.
const MAX_UPLOAD_BYTES = 100 * 1024;

export type UploadLyricsOutcome =
    | { kind: 'auth' } // 401 / 403 — not allowed
    | { kind: 'empty' } // body resolved to empty string
    | { kind: 'failed'; status: number } // other HTTP error
    | { kind: 'network' } // fetch threw
    | { kind: 'success' }
    | { kind: 'tooLarge' }; // body > MAX_UPLOAD_BYTES

/**
 * Upload lyrics to a Jellyfin server.
 *
 * Jellyfin's UploadLyrics endpoint takes the raw lyric file body and
 * derives the format from the filename + content. We always send LRC for
 * synced lyrics (preserving timestamps) and plain text for unsynced.
 *
 *   POST /Audio/{itemId}/Lyrics?fileName=lyrics.{lrc|txt}
 *   Content-Type: text/plain
 *   Body: <raw content>
 *
 * Older Jellyfin versions used a multipart form upload; this format works
 * against the modern lyrics endpoint added in 10.9+.
 *
 * Returns a typed outcome so the caller can surface a specific error
 * message (auth vs network vs too-large) rather than the previous generic
 * "couldn't save" toast.
 */
export const uploadLyricsToServer = async ({
    itemId,
    lyrics,
    server,
}: UploadArgs): Promise<UploadLyricsOutcome> => {
    const baseUrl = getServerUrl(server);
    if (!baseUrl || !server.credential) return { kind: 'auth' };
    const serverUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const authHeader = `${createAuthHeader()}, Token="${server.credential}"`;

    const isSynced = lyrics.lyrics && Array.isArray(lyrics.lyrics);
    const body = isSynced
        ? formatLrc(lyrics.lyrics as SynchronizedLyricsArray)
        : String(lyrics.lyrics ?? '');
    const fileName = isSynced ? 'lyrics.lrc' : 'lyrics.txt';

    if (body.length === 0) return { kind: 'empty' };
    // Byte-length, not char-length — multi-byte UTF-8 lyrics shouldn't
    // sneak past a char cap.
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_UPLOAD_BYTES) return { kind: 'tooLarge' };

    try {
        const res = await fetch(
            `${serverUrl}/Audio/${encodeURIComponent(itemId)}/Lyrics?fileName=${encodeURIComponent(fileName)}`,
            {
                body,
                headers: {
                    Authorization: authHeader,
                    'Content-Type': 'text/plain',
                },
                method: 'POST',
            },
        );
        if (res.ok) return { kind: 'success' };
        if (res.status === 401 || res.status === 403) return { kind: 'auth' };
        return { kind: 'failed', status: res.status };
    } catch (err) {
        console.warn('[upload-lyrics] failed', err);
        return { kind: 'network' };
    }
};
