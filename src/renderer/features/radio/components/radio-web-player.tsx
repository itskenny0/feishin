import type ReactPlayer from 'react-player';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
    WebPlayerEngine,
    WebPlayerEngineHandle,
} from '/@/renderer/features/player/audio-player/engine/web-player-engine';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import {
    useIsRadioActive,
    useRadioPlayer,
    useRadioStore,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { usePlaybackSettings, usePlayerMuted, usePlayerVolume } from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import { PlayerStatus } from '/@/shared/types/types';

export function RadioWebPlayer() {
    const playerRef = useRef<null | WebPlayerEngineHandle>(null);
    const { currentStreamUrl, isPlaying } = useRadioPlayer();
    const stop = useRadioStore((state) => state.actions.stop);
    const isRadioActive = useIsRadioActive();
    const isMuted = usePlayerMuted();
    const volume = usePlayerVolume();
    const { preservePitch } = usePlaybackSettings();
    const { webAudio } = useWebAudio();

    const playerStatus = isPlaying ? PlayerStatus.PLAYING : PlayerStatus.PAUSED;
    const [player1Source, setPlayer1Source] = useState<MediaElementAudioSourceNode | null>(null);
    const processedMediaElementRef = useRef<HTMLMediaElement | null>(null);
    const player1SourceRef = useRef<MediaElementAudioSourceNode | null>(null);

    usePlayerEvents(
        {
            onPlayerVolume: (properties) => {
                const volume = properties.volume;
                playerRef.current?.setVolume(volume);
            },
        },
        [volume],
    );

    useEffect(() => {
        player1SourceRef.current = player1Source;
    }, [player1Source]);

    // Cleanup source only on unmount
    useEffect(() => {
        return () => {
            if (player1SourceRef.current) {
                try {
                    player1SourceRef.current.disconnect();
                } catch {
                    // Ignore disconnect errors
                }
                setPlayer1Source(null);
                processedMediaElementRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!webAudio || !player1Source) return;

        const linearVolume = volume / 100;
        const gainValue = isMuted ? 0 : linearVolume;

        try {
            webAudio.gains[0].gain.setValueAtTime(gainValue, 0);
        } catch (error) {
            console.error('Error setting radio volume gain', error);
        }
    }, [volume, isMuted, webAudio, player1Source]);

    const handlePlayer1Start = useCallback(
        async (player: ReactPlayer) => {
            if (!webAudio) return;

            const internal = player.getInternalPlayer() as HTMLMediaElement | undefined;
            if (!internal) return;

            // Already wired this exact media element: its source stays connected.
            if (processedMediaElementRef.current === internal && player1Source) return;

            if (currentStreamUrl) {
                if (webAudio.context.state !== 'running') {
                    await webAudio.context.resume();
                }
            }

            try {
                const { context, gains } = webAudio;
                const source = context.createMediaElementSource(internal);
                source.connect(gains[0]);
                setPlayer1Source(source);
                processedMediaElementRef.current = internal;
            } catch {
                processedMediaElementRef.current = internal;

                if (webAudio && webAudio.gains[0]) {
                    const linearVolume = volume / 100;
                    const gainValue = isMuted ? 0 : linearVolume;
                    webAudio.gains[0].gain.setValueAtTime(gainValue, 0);
                }
            }
        },
        [player1Source, currentStreamUrl, webAudio, volume, isMuted],
    );

    // stop() (not just clearing the stream URL) also stops the player store:
    // radio playback set it to PLAYING, so the queue's WebPlayer, which mounts
    // once radio is inactive, would otherwise start playing the queue.
    const onEndedPlayer1 = useCallback(() => {
        console.error('Radio stream ended unexpectedly');
        stop();
        toast.error({ message: 'Radio stream ended unexpectedly' });
    }, [stop]);

    if (!isRadioActive) {
        return null;
    }

    return (
        <WebPlayerEngine
            isMuted={isMuted}
            isTransitioning={false}
            loopPlayer1={false}
            loopPlayer2={false}
            onEndedPlayer1={onEndedPlayer1}
            onEndedPlayer2={() => {}}
            onErrorPause={() => {}}
            onProgressPlayer1={() => {}}
            onProgressPlayer2={() => {}}
            onStartedPlayer1={handlePlayer1Start}
            onStartedPlayer2={() => {}}
            playerNum={1}
            playerRef={playerRef}
            playerStatus={playerStatus}
            preservesPitch={preservePitch}
            speed={1}
            src1={currentStreamUrl || undefined}
            src2={undefined}
            volume={volume}
        />
    );
}
