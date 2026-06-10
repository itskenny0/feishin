import { Capacitor } from '@capacitor/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '/@/renderer/api';
import { localMediaStore } from '/@/renderer/cache/media-store';
import { useIsSongOfflineAvailable } from '/@/renderer/cache/use-offline-availability';
import { TranscodingConfig, usePlaybackType } from '/@/renderer/store';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerType } from '/@/shared/types/types';

const TAG = '[offline-media]';

// Android WebView dies natively when TWO <audio> elements hold blob sources
// at once (device telemetry: every crash frame shows blob|blob — current
// playing + next preloaded; every survival shows blob|http or a single
// blob). On native platforms only the CURRENT track may be blob-served.
const isNativePlatform = (() => {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
})();
let singleBlobSlotOnly = isNativePlatform;
/** Test seam for the native single-blob-slot guard. */
export const __setSingleBlobSlotOnlyForTests = (value: boolean): void => {
    singleBlobSlotOnly = value;
};

export function useSongUrl(
    song: QueueSong | undefined,
    current: boolean,
    transcode: Partial<TranscodingConfig>,
): string | undefined {
    const prior = useRef(['', '']);
    const { pending: offlinePending, url: offlineUrl } = useOfflineSongUrl(song, current);

    const shouldReusePrior = Boolean(
        song?._serverId && current && prior.current[0] === song._uniqueId && prior.current[1],
    );

    const { data: queryStreamUrl } = useQuery({
        // Skip the remote resolve entirely when a local blob is serving this
        // song — keeps the app working with the backend unreachable. Also hold
        // off while the local lookup is in flight so a downloaded song never
        // briefly hits the network on first render.
        enabled: Boolean(song?._serverId) && !shouldReusePrior && !offlineUrl && !offlinePending,
        queryFn: () =>
            api.controller.getStreamUrl({
                apiClientProps: { serverId: song!._serverId },
                query: {
                    bitrate: transcode.bitrate,
                    format: transcode.format,
                    id: song!.id,
                    transcode: transcode.enabled ?? false,
                },
            }),
        queryKey: [
            song?._serverId,
            'stream-url',
            song?.id,
            shouldReusePrior ? 'reuse-prior' : transcode.bitrate,
            shouldReusePrior ? 'reuse-prior' : transcode.format,
            shouldReusePrior ? 'reuse-prior' : transcode.enabled,
        ] as const,
        staleTime: 60 * 1000,
    });

    useEffect(() => {
        if (!song?._serverId) {
            prior.current = ['', ''];
            return;
        }

        if (!queryStreamUrl) {
            return;
        }

        // Save resolved URL to avoid restarting current track on transcode setting changes.
        prior.current = [song._uniqueId, queryStreamUrl];
    }, [song?._serverId, song?._uniqueId, queryStreamUrl]);

    useEffect(() => {
        if (!song?._serverId) {
            prior.current = ['', ''];
        }
    }, [song?._serverId]);

    // Local blob takes precedence over everything (including the reuse-prior
    // remote URL) so offline playback wins even mid-track on a server drop.
    if (offlineUrl) return offlineUrl;

    return shouldReusePrior ? prior.current[1] : queryStreamUrl;
}

/**
 * Offline-playback substitution.
 *
 * If the song has a locally-downloaded audio blob (LocalMediaStore) we serve a
 * `blob:` object URL instead of streaming from the backend — so playback keeps
 * working when the server is unreachable. IMPORTANT: a `blob:` URL only works
 * on the WEB AUDIO engine (ReactPlayer / <audio>). The Electron MPV engine
 * cannot play blob URLs, so we never substitute when the active engine is
 * `local` (MPV) — and the MPV engine resolves its URL through `getSongUrl`
 * below, not this hook, so it is unaffected regardless.
 *
 * Returns `{ url, pending }`. `url` is the blob object URL when a local copy
 * exists, else undefined (caller falls back to the remote query). `pending`
 * is true while the (web-engine only) local lookup is in flight, so the caller
 * can hold the remote stream-URL query until we know whether a local copy
 * exists — this keeps a downloaded song from briefly hitting the network on
 * the first render. Manages the object-URL lifecycle: the previous URL is
 * revoked whenever the song changes or the component unmounts, so we never
 * leak object URLs.
 */
function useOfflineSongUrl(
    song: QueueSong | undefined,
    current: boolean,
): { pending: boolean; url: string | undefined } {
    const playbackType = usePlaybackType();
    // The settled verdict of the LAST COMPLETED lookup, keyed by the song it
    // was for. Keying lets `pending` be DERIVED during render: when the song
    // changes, the very first render already reports pending — the old
    // setPending-in-effect approach left one commit window where the remote
    // query fired (jellyfin's getStreamUrl is a sync URL builder, so offline
    // it still "succeeds" instantly) and handed the audio element a dead
    // network URL; its error handler then paused playback before the blob
    // could swap in.
    const [settled, setSettled] = useState<null | { key: string; url: string | undefined }>(null);
    const objectUrlRef = useRef<string | undefined>(undefined);
    const pendingRevokeRef = useRef<string | undefined>(undefined);
    // Reactive availability signal. The Dexie lookup below can race the
    // offline-media boot (the index loads ~seconds after first render): a
    // lookup that runs too early concludes "no local copy" and that verdict
    // used to be cached in state for the rest of the session — an OFFLINE
    // app launch then played a dead network URL forever. Subscribing to the
    // availability index re-runs the lookup when the index lands at boot or
    // when a download completes mid-session.
    const songAvailableOffline = useIsSongOfflineAvailable(song?._serverId, song?.id);

    // MPV cannot play blob URLs — only substitute for the web-audio path.
    // On desktop/web, substitution applies to EVERY player slot (the preload
    // blob gives gapless playback offline). On NATIVE platforms only the
    // CURRENT slot may hold a blob: device telemetry shows the Android
    // WebView render process dying natively whenever both audio elements
    // hold blob sources at once (every crash frame = blob|blob; every
    // survival = blob|http or a single blob). A downloaded next track is
    // HELD on native (no src at all) rather than preloaded from the dead
    // remote URL — its blob lands ~20ms after it becomes current.
    const heldPreload = Boolean(
        singleBlobSlotOnly &&
        !current &&
        songAvailableOffline &&
        song?._serverId &&
        playbackType === PlayerType.WEB,
    );
    const targetKey =
        song?._serverId && playbackType === PlayerType.WEB && !heldPreload
            ? `${song._serverId}|${song.id}`
            : null;

    // Deferred one-generation revocation. Recovered device telemetry showed
    // the Android WebView render process dying natively the moment an object
    // URL was revoked while the <audio> element was still streaming it (the
    // death frame is a second "serving local blob" for the SAME song). A URL
    // is therefore never revoked when it might still be attached: minting a
    // new URL revokes only the one from TWO generations back; everything
    // still held is revoked on unmount, after React has detached the source.
    const retireUrl = (url: string | undefined): void => {
        if (!url) return;
        if (pendingRevokeRef.current) {
            URL.revokeObjectURL(pendingRevokeRef.current);
        }
        pendingRevokeRef.current = url;
    };

    useEffect(() => {
        let cancelled = false;

        if (!targetKey || !song) {
            retireUrl(objectUrlRef.current);
            objectUrlRef.current = undefined;
            setSettled(null);
            return () => {
                cancelled = true;
            };
        }

        // Already serving this exact song from a blob? Do NOT look up again.
        // The availability-index dep re-fires this effect after the index
        // lands; re-minting (and revoking the in-use URL) was the crash.
        if (settled?.key === targetKey && settled.url) {
            return () => {
                cancelled = true;
            };
        }

        void (async () => {
            try {
                const row = await localMediaStore.get(song._serverId, song.id);
                if (cancelled) return;
                if (row?.Blob) {
                    // MATERIALIZE the blob into memory before minting the
                    // object URL. Dexie returns IndexedDB-FILE-BACKED blobs;
                    // handing one to the Android media element ties playback
                    // to the IDB blob registry. An in-memory copy detaches it.
                    // Costs the compressed file size in RAM transiently —
                    // fine for music files.
                    const bytes = await row.Blob.arrayBuffer();
                    if (cancelled) return;
                    const materialized = new Blob([bytes], {
                        type: row.Blob.type || 'audio/mpeg',
                    });
                    retireUrl(objectUrlRef.current);
                    const url = URL.createObjectURL(materialized);
                    objectUrlRef.current = url;
                    console.info(`${TAG} playback substitution: serving local blob`, {
                        bytes: row.ByteSize,
                        materialized: true,
                        songId: song.id,
                    });
                    setSettled({ key: targetKey, url });
                } else {
                    retireUrl(objectUrlRef.current);
                    objectUrlRef.current = undefined;
                    setSettled({ key: targetKey, url: undefined });
                }
            } catch (err) {
                if (!cancelled) {
                    console.warn(`${TAG} substitution lookup failed`, err);
                    setSettled({ key: targetKey, url: undefined });
                }
            }
        })();

        // Deps-change cleanup must NOT revoke: the element may still be
        // streaming the URL (that revoke was the Android crash).
        return () => {
            cancelled = true;
        };
        // song is fully represented by targetKey; listing it would re-run on
        // every queue rebuild (new object identity, same song). `settled` is
        // read for the already-serving short-circuit but must not re-trigger
        // the effect (it is this effect's own output).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetKey, playbackType, songAvailableOffline]);

    // Unmount-only: by the time this runs React has detached our URLs from
    // the audio element, so revoking everything still held is safe.
    useEffect(() => {
        return () => {
            if (objectUrlRef.current) {
                URL.revokeObjectURL(objectUrlRef.current);
                objectUrlRef.current = undefined;
            }
            if (pendingRevokeRef.current) {
                URL.revokeObjectURL(pendingRevokeRef.current);
                pendingRevokeRef.current = undefined;
            }
        };
    }, []);

    const isSettledForThisSong = targetKey !== null && settled?.key === targetKey;
    return {
        // Pending whenever a lookup is owed for the current song — including
        // the renders BEFORE the effect commits its verdict. A held native
        // preload reports pending FOREVER so the remote stream-url query
        // stays disabled too: offline that URL is dead, and its error
        // handler pauses both players.
        pending: heldPreload || (targetKey !== null && !isSettledForThisSong),
        url: isSettledForThisSong ? settled.url : undefined,
    };
}

export const getSongUrl = async (
    song: QueueSong,
    transcode: Partial<TranscodingConfig>,
    skipAutoTranscode?: boolean,
) => {
    const url = await api.controller.getStreamUrl({
        apiClientProps: { serverId: song._serverId },
        query: {
            bitrate: transcode.bitrate,
            format: transcode.format,
            id: song.id,
            skipAutoTranscode,
            transcode: transcode.enabled ?? false,
        },
    });

    return url;
};
