import type { RefObject } from 'react';
import type ReactPlayer from 'react-player';

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import {
    mediaErrorLabel,
    redactMediaSrc,
} from '/@/renderer/features/player/audio-player/engine/media-error';
import { AudioPlayer, PlayerOnProgressProps } from '/@/renderer/features/player/audio-player/types';
import { convertToLogVolume } from '/@/renderer/features/player/audio-player/utils/player-utils';
import { LogCategory, logFn } from '/@/renderer/utils/logger';
import { logMsg } from '/@/renderer/utils/logger-message';
import { PlayerStatus } from '/@/shared/types/types';

export interface WebPlayerEngineHandle extends AudioPlayer {
    player1(): {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    player2(): {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
}

interface WebPlayerEngineProps {
    isMuted: boolean;
    isTransitioning: boolean;
    loopPlayer1: boolean;
    loopPlayer2: boolean;
    onEndedPlayer1: () => void;
    onEndedPlayer2: () => void;
    onErrorPause: () => void;
    onProgressPlayer1: (e: PlayerOnProgressProps) => void;
    onProgressPlayer2: (e: PlayerOnProgressProps) => void;
    onStartedPlayer1: (player: ReactPlayer) => void;
    onStartedPlayer2: (player: ReactPlayer) => void;
    playerNum: number;
    playerRef: RefObject<null | WebPlayerEngineHandle>;
    playerStatus: PlayerStatus;
    preservesPitch: boolean;
    speed?: number;
    src1: string | undefined;
    src2: string | undefined;
    volume: number;
}

const MAX_NETWORK_RETRIES = 5;
const NETWORK_RETRY_DELAY_MS = 2000;

// Credits: https://gist.github.com/novwhisky/8a1a0168b94f3b6abfaa?permalink_comment_id=1551393#gistcomment-1551393
// This is used so that the player will always have an <audio> element. This means that
// player1Source and player2Source are connected BEFORE the user presses play for
// the first time. This workaround is important for Safari, which seems to require the
// source to be connected PRIOR to resuming audio context
const EMPTY_SOURCE =
    'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV';

export const WebPlayerEngine = (props: WebPlayerEngineProps) => {
    const {
        isMuted,
        isTransitioning,
        loopPlayer1,
        loopPlayer2,
        onEndedPlayer1,
        onEndedPlayer2,
        onErrorPause,
        onProgressPlayer1,
        onProgressPlayer2,
        onStartedPlayer1,
        onStartedPlayer2,
        playerNum,
        playerRef,
        playerStatus,
        preservesPitch,
        speed,
        src1,
        src2,
        volume,
    } = props;

    const player1Ref = useRef<null | ReactPlayer>(null);
    const player2Ref = useRef<null | ReactPlayer>(null);
    const networkRetryCount1 = useRef(0);
    const networkRetryCount2 = useRef(0);
    // Track pending retry timers so a mid-flight retry can be aborted
    // when the src changes (user skipped past the failing track) or the
    // component unmounts. Without this, a 2s-delayed audio.play() can
    // fire against a stale media element after the next song has loaded
    // and momentarily double-route audio.
    const networkRetryTimer1 = useRef<NodeJS.Timeout | null>(null);
    const networkRetryTimer2 = useRef<NodeJS.Timeout | null>(null);
    const [ReactPlayerComponent, setReactPlayerComponent] = useState<null | typeof ReactPlayer>(
        null,
    );
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        const loadReactPlayer = async () => {
            try {
                const module = await import('react-player');
                if (isMounted) {
                    setReactPlayerComponent(() => module.default);
                    setIsLoading(false);
                }
            } catch (error) {
                console.error('Failed to load react-player:', error);
                setIsLoading(false);
            }
        };

        loadReactPlayer();

        return () => {
            isMounted = false;
        };
    }, []);

    const [internalVolume1, setInternalVolume1] = useState(volume / 100 || 0);
    const [internalVolume2, setInternalVolume2] = useState(volume / 100 || 0);

    useImperativeHandle<WebPlayerEngineHandle, WebPlayerEngineHandle>(playerRef, () => ({
        decreaseVolume(by: number) {
            // Use functional updates so back-to-back presses compound
            // against the latest state instead of the value captured
            // when this imperative handle was first installed.
            setInternalVolume1((prev) => Math.max(0, prev - by / 100));
            setInternalVolume2((prev) => Math.max(0, prev - by / 100));
        },
        increaseVolume(by: number) {
            setInternalVolume1((prev) => Math.min(1, prev + by / 100));
            setInternalVolume2((prev) => Math.min(1, prev + by / 100));
        },
        pause() {
            player1Ref.current?.getInternalPlayer()?.pause();
            player2Ref.current?.getInternalPlayer()?.pause();
        },
        play() {
            player1Ref.current?.getInternalPlayer()?.pause();
            player2Ref.current?.getInternalPlayer()?.pause();
            if (playerNum === 1) {
                player1Ref.current?.getInternalPlayer()?.play();
            } else {
                player2Ref.current?.getInternalPlayer()?.play();
            }
        },
        player1() {
            return {
                ref: player1Ref?.current,
                setVolume: (volume: number) => setInternalVolume1(volume / 100 || 0),
            };
        },
        player2() {
            return {
                ref: player2Ref?.current,
                setVolume: (volume: number) => setInternalVolume2(volume / 100 || 0),
            };
        },
        seekTo(seekTo: number) {
            let type: 'fraction' | 'seconds' | undefined = undefined;

            if (seekTo < 1) {
                type = 'seconds';
            }

            playerNum === 1
                ? player1Ref.current?.seekTo(seekTo, type)
                : player2Ref.current?.seekTo(seekTo, type);
        },
        setVolume(volume: number) {
            setInternalVolume1(volume / 100 || 0);
            setInternalVolume2(volume / 100 || 0);
        },
        setVolume1(volume: number) {
            setInternalVolume1(volume / 100 || 0);
        },
        setVolume2(volume: number) {
            setInternalVolume2(volume / 100 || 0);
        },
    }));

    const volume1 = convertToLogVolume(internalVolume1);
    const volume2 = convertToLogVolume(internalVolume2);

    const pauseBothPlayers = useCallback(() => {
        player1Ref.current?.getInternalPlayer()?.pause();
        player2Ref.current?.getInternalPlayer()?.pause();
    }, []);

    const handleOnError = (
        playerRef: React.RefObject<null | ReactPlayer>,
        onEnded: () => void,
        onErrorPause: () => void,
        networkRetryCountRef: React.RefObject<number>,
        networkRetryTimerRef: React.RefObject<NodeJS.Timeout | null>,
    ) => {
        return ({ target }: ErrorEvent) => {
            const { current: player } = playerRef;

            if (!player || !(target instanceof Audio)) {
                return;
            }

            const { error } = target;

            // `MediaError` stringifies to `{}` (code/message are non-enumerable),
            // so decode it into something the shipped logs can act on: the error
            // kind, numeric code, message, and the failing host+path (query
            // dropped so the apiKey never reaches the logs).
            logFn.error(logMsg[LogCategory.PLAYER].playbackError, {
                category: LogCategory.PLAYER,
                meta: {
                    code: error?.code,
                    kind: mediaErrorLabel(error?.code),
                    message: error?.message || undefined,
                    src: redactMediaSrc(target.currentSrc || target.src),
                },
            });

            const isNetworkError =
                error?.code === MediaError.MEDIA_ERR_NETWORK ||
                error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;

            if (isNetworkError) {
                if (networkRetryCountRef.current < MAX_NETWORK_RETRIES) {
                    networkRetryCountRef.current += 1;
                    const audio = target;
                    if (networkRetryTimerRef.current) {
                        clearTimeout(networkRetryTimerRef.current);
                    }
                    networkRetryTimerRef.current = setTimeout(() => {
                        networkRetryTimerRef.current = null;
                        pauseBothPlayers();
                        audio.load();
                        audio.play().catch(() => {
                            logFn.error(logMsg[LogCategory.PLAYER].playbackError, {
                                category: LogCategory.PLAYER,
                                meta: { error: 'Failed to play audio after network error' },
                            });
                        });
                    }, NETWORK_RETRY_DELAY_MS);
                    return;
                }
            }

            if (error?.code !== MediaError.MEDIA_ERR_DECODE && !isNetworkError) {
                return;
            }

            pauseBothPlayers();
            if (error?.code === MediaError.MEDIA_ERR_DECODE) {
                onEnded();
            } else {
                if (onErrorPause) {
                    onErrorPause();
                }
            }
        };
    };

    useEffect(() => {
        networkRetryCount1.current = 0;
        // Cancel any pending retry: a mid-flight audio.play() against
        // the previous src would fight the user's skip or the new track
        // and briefly produce stale-audio bursts.
        if (networkRetryTimer1.current) {
            clearTimeout(networkRetryTimer1.current);
            networkRetryTimer1.current = null;
        }
    }, [src1]);

    useEffect(() => {
        networkRetryCount2.current = 0;
        if (networkRetryTimer2.current) {
            clearTimeout(networkRetryTimer2.current);
            networkRetryTimer2.current = null;
        }
    }, [src2]);

    // Cancel any pending retries on unmount so a 2s-delayed play()
    // doesn't fire against a torn-down audio element.
    useEffect(() => {
        return () => {
            if (networkRetryTimer1.current) {
                clearTimeout(networkRetryTimer1.current);
                networkRetryTimer1.current = null;
            }
            if (networkRetryTimer2.current) {
                clearTimeout(networkRetryTimer2.current);
                networkRetryTimer2.current = null;
            }
        };
    }, []);

    // When not transitioning, ensure only the active player can play (e.g. after seek/prev during transition)
    useEffect(() => {
        if (isTransitioning) return;
        if (playerStatus !== PlayerStatus.PLAYING) {
            pauseBothPlayers();
            return;
        }
        if (playerNum === 1) {
            player2Ref.current?.getInternalPlayer()?.pause();
        } else {
            player1Ref.current?.getInternalPlayer()?.pause();
        }
    }, [isTransitioning, playerNum, playerStatus, pauseBothPlayers]);

    // Recover from a STUCK media error on (re)play. Per the HTML5 media spec, an
    // <audio> element that has errored keeps its `error` set and will refuse to
    // play again until load() is called. ReactPlayer only calls load() when the
    // `url` prop changes, so pressing play on the SAME song after an error was a
    // permanent dead-end — the element stayed errored and silently refused to
    // start (the recovered "song won't play even on retry" report). When
    // playback is (re)started, reload the active player if it's sitting on an
    // error and give the manual replay a fresh set of network retries. Guarded
    // on `element.error` so healthy play/pause toggles are untouched.
    useEffect(() => {
        if (playerStatus !== PlayerStatus.PLAYING) return;
        const activeRef = playerNum === 1 ? player1Ref : player2Ref;
        const active = activeRef.current?.getInternalPlayer();
        if (active instanceof HTMLAudioElement && active.error) {
            (playerNum === 1 ? networkRetryCount1 : networkRetryCount2).current = 0;
            active.load();
            active.play().catch(() => {
                // Still failing (e.g. network down) — the onError handler logs
                // it and the retry loop takes over; nothing more to do here.
            });
        }
    }, [playerStatus, playerNum]);

    useEffect(() => {
        const player1 = player1Ref.current?.getInternalPlayer();
        if (player1 && player1 instanceof HTMLAudioElement) {
            player1.preservesPitch = preservesPitch;
        }
        const player2 = player2Ref.current?.getInternalPlayer();
        if (player2 && player2 instanceof HTMLAudioElement) {
            player2.preservesPitch = preservesPitch;
        }
    }, [preservesPitch]);

    const handleOnReadyPlayer1 = useCallback(
        (player: ReactPlayer) => {
            const internal = player.getInternalPlayer();
            if (internal && internal instanceof HTMLAudioElement) {
                internal.preservesPitch = preservesPitch;
            }
            onStartedPlayer1(player);
        },
        [onStartedPlayer1, preservesPitch],
    );

    const handleOnReadyPlayer2 = useCallback(
        (player: ReactPlayer) => {
            const internal = player.getInternalPlayer();
            if (internal && internal instanceof HTMLAudioElement) {
                internal.preservesPitch = preservesPitch;
            }
            onStartedPlayer2(player);
        },
        [onStartedPlayer2, preservesPitch],
    );

    if (isLoading || !ReactPlayerComponent) {
        return <div id="web-player-engine" style={{ display: 'none' }} />;
    }

    return (
        <div id="web-player-engine" style={{ display: 'none' }}>
            <ReactPlayerComponent
                config={{
                    file: { attributes: { crossOrigin: 'anonymous' }, forceAudio: true },
                }}
                controls={false}
                height={0}
                id="web-player-1"
                loop={loopPlayer1}
                muted={isMuted}
                onEnded={src1 && !loopPlayer1 ? () => onEndedPlayer1() : undefined}
                onError={handleOnError(
                    player1Ref,
                    () => onEndedPlayer1(),
                    onErrorPause,
                    networkRetryCount1,
                    networkRetryTimer1,
                )}
                onProgress={onProgressPlayer1}
                onReady={handleOnReadyPlayer1}
                playbackRate={speed || 1}
                playing={playerNum === 1 && playerStatus === PlayerStatus.PLAYING}
                progressInterval={isTransitioning ? 10 : 250}
                ref={player1Ref}
                url={src1 || EMPTY_SOURCE}
                volume={volume1}
                width={0}
            />
            <ReactPlayerComponent
                config={{
                    file: { attributes: { crossOrigin: 'anonymous' }, forceAudio: true },
                }}
                controls={false}
                height={0}
                id="web-player-2"
                loop={loopPlayer2}
                muted={isMuted}
                onEnded={src2 && !loopPlayer2 ? () => onEndedPlayer2() : undefined}
                onError={handleOnError(
                    player2Ref,
                    () => onEndedPlayer2(),
                    onErrorPause,
                    networkRetryCount2,
                    networkRetryTimer2,
                )}
                onProgress={onProgressPlayer2}
                onReady={handleOnReadyPlayer2}
                playbackRate={speed || 1}
                playing={playerNum === 2 && playerStatus === PlayerStatus.PLAYING}
                progressInterval={isTransitioning ? 10 : 250}
                ref={player2Ref}
                url={src2 || EMPTY_SOURCE}
                volume={volume2}
                width={0}
            />
        </div>
    );
};

WebPlayerEngine.displayName = 'WebPlayerEngine';
