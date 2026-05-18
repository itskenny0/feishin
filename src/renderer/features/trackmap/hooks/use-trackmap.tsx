import type { TrackmapData, TrackmapStatus } from '/@/renderer/features/trackmap/types';
import type { QueueSong } from '/@/shared/types/domain-types';

import { useEffect, useState } from 'react';

import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { analyzeSong } from '/@/renderer/features/trackmap/analysis/analyze-song';
import { useCurrentServer } from '/@/renderer/store/auth.store';
import {
    useTrackmapEnabled,
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
    const currentServer = useCurrentServer();
    const isUsingRemoteUrl = Boolean(currentServer?.preferRemoteUrl);

    const serverId = song?._serverId;
    const songId = song?.id;
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

        analyzeSong({
            allowNetwork: !(onlyOverLan && isUsingRemoteUrl),
            sensitivity,
            serverId,
            signal: ac.signal,
            songId,
            streamUrl: streamUrl ?? undefined,
        })
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
                console.warn('[trackmap] analysis failed', err);
                setState({ data: null, status: 'error' });
            });

        return () => ac.abort();
    }, [enabled, isUsingRemoteUrl, onlyOverLan, sensitivity, serverId, songId, streamUrl]);

    return state;
};
