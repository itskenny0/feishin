import type { TrackmapData, TrackmapStatus } from '/@/renderer/features/trackmap/types';
import type { QueueSong } from '/@/shared/types/domain-types';

import { useEffect, useState } from 'react';

import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import {
    analyzeSong,
    TrackmapUndecodableError,
} from '/@/renderer/features/trackmap/analysis/analyze-song';
import { waitForPlaybackFlowing } from '/@/renderer/features/trackmap/analysis/defer-until-playing';
import { useCurrentServer } from '/@/renderer/store/auth.store';
import {
    useTrackmapEnabled,
    useTrackmapMaxFileSizeMb,
    useTrackmapOnlyOverLan,
    useTrackmapSensitivity,
} from '/@/renderer/store/settings.store';

interface UseTrackmapResult {
    data: null | TrackmapData;
    status: TrackmapStatus;
}

// Match the existing wavesurfer transcode hint so the fetched bytes are
// the same MP3 the seek slider visualises and the HTTP cache dedupes
// the download with playback (web player path).
const TRACKMAP_TRANSCODE = { bitrate: 64, enabled: false, format: 'mp3' as const };

export const useTrackmap = (song: null | QueueSong): UseTrackmapResult => {
    const enabled = useTrackmapEnabled();
    const onlyOverLan = useTrackmapOnlyOverLan();
    const sensitivity = useTrackmapSensitivity();
    const maxFileSizeMb = useTrackmapMaxFileSizeMb();
    const currentServer = useCurrentServer();
    const isUsingRemoteUrl = Boolean(currentServer?.preferRemoteUrl);

    const serverId = song?._serverId;
    const songId = song?.id;
    // Declared source size (bytes), if the server reports it. Lets analyzeSong
    // skip the download for sources over the user cap.
    const songSizeBytes = song?.size ?? null;
    // User cap is stored in MB; 0 = unlimited.
    const maxFileSizeBytes = maxFileSizeMb > 0 ? maxFileSizeMb * 1024 * 1024 : 0;
    const streamUrl = useSongUrl(song ?? undefined, true, TRACKMAP_TRANSCODE);

    const [state, setState] = useState<UseTrackmapResult>({
        data: null,
        status: 'idle',
    });

    useEffect(() => {
        if (!enabled || !serverId || !songId) {
            setState({ data: null, status: 'idle' });
            return;
        }

        const ac = new AbortController();
        setState({ data: null, status: 'loading' });

        // Don't race the playback stream: the analysis downloads + decodes
        // the whole file, so starting it at click time inflates
        // click-to-sound latency. Wait until sound is flowing (cap 4s so a
        // paused queue restore still gets its trackmap).
        waitForPlaybackFlowing({ maxWaitMs: 4000, signal: ac.signal, songId })
            .then(() =>
                analyzeSong({
                    allowNetwork: !(onlyOverLan && isUsingRemoteUrl),
                    maxFileSizeBytes,
                    sensitivity,
                    serverId,
                    signal: ac.signal,
                    songId,
                    songSizeBytes,
                    streamUrl: streamUrl ?? undefined,
                }),
            )
            .then((data) => {
                if (ac.signal.aborted) return;
                if (data) {
                    setState({ data, status: 'ready' });
                } else {
                    setState({ data: null, status: 'idle' });
                }
            })
            .catch((err) => {
                if (ac.signal.aborted) return;
                if (err instanceof DOMException && err.name === 'AbortError') return;
                // Codecs the WebView can't decode are expected on some platforms
                // and don't affect playback — only the trackmap visual is skipped
                // (and the failure is negative-cached so it isn't retried). Log at
                // info, not warn, so it doesn't read as a fault.
                if (err instanceof TrackmapUndecodableError || err?.expected === true) {
                    console.info(
                        '[trackmap] skipping visual: source codec not decodable by this WebView (playback unaffected)',
                    );
                } else {
                    console.warn('[trackmap] analysis failed', err);
                }
                setState({ data: null, status: 'error' });
            });

        return () => ac.abort();
    }, [
        enabled,
        isUsingRemoteUrl,
        maxFileSizeBytes,
        onlyOverLan,
        sensitivity,
        serverId,
        songId,
        songSizeBytes,
        streamUrl,
    ]);

    return state;
};
