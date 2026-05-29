import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '/@/renderer/api';
import { localMediaStore } from '/@/renderer/cache/media-store';
import { TranscodingConfig, usePlaybackType } from '/@/renderer/store';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerType } from '/@/shared/types/types';

const TAG = '[offline-media]';

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
    const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
    // Start "pending" on the web engine so the remote query waits for the
    // first lookup. Non-web (MPV) never substitutes, so it's never pending.
    const [pending, setPending] = useState<boolean>(playbackType === PlayerType.WEB);
    const objectUrlRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        const revoke = (): void => {
            if (objectUrlRef.current) {
                URL.revokeObjectURL(objectUrlRef.current);
                objectUrlRef.current = undefined;
            }
        };

        // MPV cannot play blob URLs — only substitute for the web-audio path.
        if (!song?._serverId || !current || playbackType !== PlayerType.WEB) {
            revoke();
            setBlobUrl(undefined);
            setPending(false);
            return () => {
                cancelled = true;
            };
        }

        setPending(true);
        void (async () => {
            try {
                const row = await localMediaStore.get(song._serverId, song.id);
                if (cancelled) return;
                if (row?.Blob) {
                    revoke();
                    const url = URL.createObjectURL(row.Blob);
                    objectUrlRef.current = url;
                    console.info(`${TAG} playback substitution: serving local blob`, {
                        bytes: row.ByteSize,
                        songId: song.id,
                    });
                    setBlobUrl(url);
                } else {
                    revoke();
                    setBlobUrl(undefined);
                }
            } catch (err) {
                if (!cancelled) {
                    console.warn(`${TAG} substitution lookup failed`, err);
                    setBlobUrl(undefined);
                }
            } finally {
                if (!cancelled) setPending(false);
            }
        })();

        return () => {
            cancelled = true;
            revoke();
        };
    }, [song?._serverId, song?.id, current, playbackType]);

    return { pending, url: blobUrl };
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
