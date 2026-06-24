import isElectron from 'is-electron';
import { debounce } from 'lodash';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import {
    subscribeCurrentTrack,
    subscribePlayerStatus,
    usePlaybackSettings,
    usePlayerStore,
    useSettingsStore,
    useSkipButtons,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

// `navigator.mediaSession` is missing in some Android System WebView builds
// (Capacitor APKs land in one of them — the v20j boot-error overlay
// pinpointed an unguarded setActionHandler on undefined). MediaMetadata
// is similarly gated. Read both with a guard so the bundle can boot on a
// WebView that lacks the API; lock-screen controls just won't work, which
// is acceptable for the tech-demo phase.
const mediaSession: MediaSession | undefined =
    typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
const hasMediaSession = Boolean(mediaSession);
const MediaMetadataCtor: typeof MediaMetadata | undefined =
    typeof window !== 'undefined' ? window.MediaMetadata : undefined;

export const useMediaSession = () => {
    const { mediaSession: mediaSessionEnabled } = usePlaybackSettings();
    const player = usePlayer();
    const skip = useSkipButtons();
    const playbackType = useSettingsStore((state) => state.playback.type);
    const isRadioActive = useIsRadioActive();
    const { isPlaying: isRadioPlaying, metadata: radioMetadata, stationName } = useRadioPlayer();

    // Keep refs to current values to avoid dependency changes triggering handler re-registration
    const playerRef = useRef(player);
    const skipRef = useRef(skip);
    const isRadioActiveRef = useRef(isRadioActive);
    const isRadioPlayingRef = useRef(isRadioPlaying);
    const radioMetadataRef = useRef(radioMetadata);
    const stationNameRef = useRef(stationName);
    const isMediaSessionEnabledRef = useRef(false);

    // Update refs whenever values change, but don't trigger effects
    useEffect(() => {
        playerRef.current = player;
    }, [player]);

    useEffect(() => {
        skipRef.current = skip;
    }, [skip]);

    useEffect(() => {
        isRadioActiveRef.current = isRadioActive;
    }, [isRadioActive]);

    useEffect(() => {
        isRadioPlayingRef.current = isRadioPlaying;
    }, [isRadioPlaying]);

    useEffect(() => {
        radioMetadataRef.current = radioMetadata;
    }, [radioMetadata]);

    useEffect(() => {
        stationNameRef.current = stationName;
    }, [stationName]);

    const isMediaSessionEnabled = useMemo(() => {
        // If the host WebView doesn't expose navigator.mediaSession, nothing
        // we do in this hook can work — bail before touching the API.
        if (!hasMediaSession) {
            return false;
        }

        // Always enable media session on web
        if (!isElectron()) {
            return true;
        }

        return Boolean(mediaSessionEnabled && playbackType === PlayerType.WEB);
    }, [mediaSessionEnabled, playbackType]);

    useEffect(() => {
        isMediaSessionEnabledRef.current = isMediaSessionEnabled;
        // If the user just disabled media session mid-playback, blank
        // the OS scrubber so we don't leave a stale position pinned
        // to the lock screen.
        if (!isMediaSessionEnabled && mediaSession) {
            if (typeof mediaSession.setPositionState === 'function') {
                try {
                    mediaSession.setPositionState();
                } catch {
                    // ignore — some WebViews throw on the zero-arg form
                }
            }
        }
    }, [isMediaSessionEnabled]);

    // Register/unregister handlers whenever isMediaSessionEnabled changes so that
    // enabling the setting after mount correctly registers handlers instead of
    // silently no-oping because the [] effect already ran.
    useEffect(() => {
        // `mediaSession` is guaranteed non-null inside this branch by the
        // `hasMediaSession` short-circuit above, but TS needs the narrow.
        if (!mediaSession) return;

        if (!isMediaSessionEnabled) {
            mediaSession.setActionHandler('nexttrack', null);
            mediaSession.setActionHandler('pause', null);
            mediaSession.setActionHandler('play', null);
            mediaSession.setActionHandler('previoustrack', null);
            mediaSession.setActionHandler('seekto', null);
            mediaSession.setActionHandler('stop', null);
            mediaSession.setActionHandler('seekbackward', null);
            mediaSession.setActionHandler('seekforward', null);

            return;
        }

        mediaSession.setActionHandler('nexttrack', () => {
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }

            playerRef.current.mediaNext();
        });

        mediaSession.setActionHandler('pause', () => {
            playerRef.current.mediaPause();
        });

        mediaSession.setActionHandler('play', () => {
            playerRef.current.mediaPlay();
        });

        mediaSession.setActionHandler('previoustrack', () => {
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }

            playerRef.current.mediaPrevious();
        });

        mediaSession.setActionHandler('seekto', (e) => {
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }

            if (e.seekTime) {
                playerRef.current.mediaSeekToTimestamp(e.seekTime);
            } else if (e.seekOffset) {
                const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                playerRef.current.mediaSeekToTimestamp(currentTimestamp + e.seekOffset);
            }
        });

        mediaSession.setActionHandler('stop', () => {
            playerRef.current.mediaStop();
        });

        mediaSession.setActionHandler('seekbackward', (e) => {
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }

            const currentTimestamp = useTimestampStoreBase.getState().timestamp;
            playerRef.current.mediaSeekToTimestamp(
                currentTimestamp - (e.seekOffset || skipRef.current?.skipBackwardSeconds || 5),
            );
        });

        mediaSession.setActionHandler('seekforward', (e) => {
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }

            const currentTimestamp = useTimestampStoreBase.getState().timestamp;
            playerRef.current.mediaSeekToTimestamp(
                currentTimestamp + (e.seekOffset || skipRef.current?.skipForwardSeconds || 5),
            );
        });

        return () => {
            mediaSession.setActionHandler('nexttrack', null);
            mediaSession.setActionHandler('pause', null);
            mediaSession.setActionHandler('play', null);
            mediaSession.setActionHandler('previoustrack', null);
            mediaSession.setActionHandler('seekto', null);
            mediaSession.setActionHandler('stop', null);
            mediaSession.setActionHandler('seekbackward', null);
            mediaSession.setActionHandler('seekforward', null);
        };
    }, [isMediaSessionEnabled]);

    const updateMediaSessionMetadata = useCallback(
        (song: QueueSong | undefined) => {
            // Read from ref so this callback is never stale regardless of when it was created
            if (!isMediaSessionEnabledRef.current) {
                return;
            }

            // hasMediaSession implies both `mediaSession` and the
            // MediaMetadata constructor are defined; the explicit guard
            // here narrows the union for TS and is also a safety net.
            if (!mediaSession || !MediaMetadataCtor) {
                return;
            }

            // Handle radio metadata when radio is active and playing
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                const title = radioMetadataRef.current?.title || stationNameRef.current || 'Radio';
                const artist = radioMetadataRef.current?.artist || stationNameRef.current || '';

                mediaSession.metadata = new MediaMetadataCtor({
                    album: stationNameRef.current || '',
                    artist: artist,
                    artwork: [],
                    title: title,
                });
                return;
            }

            // Handle regular song metadata
            if (!song) {
                return;
            }

            const imageUrl = getItemImageUrl({
                id: song?.albumId ?? song?.imageId ?? undefined,
                imageUrl: song?.imageUrl,
                itemType: LibraryItem.SONG,
                type: 'itemCard',
            });

            mediaSession.metadata = new MediaMetadataCtor({
                album: song?.album ?? '',
                artist: song?.artistName ?? '',
                artwork: imageUrl ? [{ src: imageUrl, type: 'image/png' }] : [],
                title: song?.name ?? '',
            });
        },
        // All values are read from refs — stable callback, no stale closure risk
        [],
    );

    // Debounced version to handle rapid skipping — only the last skip in a burst commits
    // to the media session. Without this, rapid MediaMetadata assignments can tear the
    // browser's media session state and permanently drop the handlers.
    const debouncedUpdateMetadata = useRef(
        debounce((song: QueueSong | undefined) => {
            updateMediaSessionMetadata(song);
        }, 100),
    ).current;

    // Cancel any pending debounced update on unmount
    useEffect(() => {
        return () => {
            debouncedUpdateMetadata.cancel();
        };
    }, [debouncedUpdateMetadata]);

    // Update metadata when radio metadata changes
    useEffect(() => {
        if (!isMediaSessionEnabled) {
            return;
        }

        if (isRadioActiveRef.current && isRadioPlayingRef.current) {
            debouncedUpdateMetadata(undefined);
        }
    }, [radioMetadata, isRadioPlaying, isMediaSessionEnabled, debouncedUpdateMetadata]);

    // Subscribe directly to the player store instead of using usePlayerEvents.
    // usePlayerEvents receives inline handler objects that cause it to re-subscribe on every
    // render, which destroys and recreates the media session on play/pause and track changes.
    // subscribeCurrentTrack and subscribePlayerStatus are stable Zustand subscriptions with
    // proper equality checks — registered once on mount and never torn down mid-session.
    useEffect(() => {
        // Position-state ticker: pushes the current playhead into the OS
        // media UI so the lock-screen scrubber tracks playback instead of
        // sitting at 0. The browser caps this at one update per second
        // anyway, so a 1s interval is the right cadence.
        let positionInterval: null | ReturnType<typeof setInterval> = null;

        const clearPositionState = () => {
            if (positionInterval) {
                clearInterval(positionInterval);
                positionInterval = null;
            }
            if (!mediaSession || typeof mediaSession.setPositionState !== 'function') {
                return;
            }
            try {
                mediaSession.setPositionState();
            } catch {
                // Some WebViews throw on the zero-arg form — safe to ignore.
            }
        };

        const pushPositionState = () => {
            if (!isMediaSessionEnabledRef.current || !mediaSession) {
                return;
            }
            if (typeof mediaSession.setPositionState !== 'function') {
                return;
            }
            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }
            // While remote-controlling, the LOCAL playhead is meaningless —
            // don't pin it to the lock screen under the remote metadata.
            if (useRemoteTargetStore.getState().targetDeviceId) {
                return;
            }
            const song = usePlayerStore.getState().getCurrentSong();
            const durationMs = song?.duration ?? 0;
            if (!song || durationMs <= 0) {
                return;
            }
            const durationSec = durationMs / 1000;
            const positionSec = Math.max(
                0,
                Math.min(durationSec, useTimestampStoreBase.getState().timestamp),
            );
            const speed = usePlayerStore.getState().player.speed ?? 1;
            try {
                mediaSession.setPositionState({
                    duration: durationSec,
                    playbackRate: speed > 0 ? speed : 1,
                    position: positionSec,
                });
            } catch {
                // setPositionState throws when duration/position become
                // inconsistent mid-skip — next tick will recover.
            }
        };

        const startPositionTicker = () => {
            if (positionInterval) return;
            // Prime immediately so the first lock-screen frame matches
            // the current playhead instead of waiting a full second.
            pushPositionState();
            positionInterval = setInterval(pushPositionState, 1000);
        };

        const unsubscribeCurrentSong = subscribeCurrentTrack(({ song }) => {
            if (!isMediaSessionEnabledRef.current) {
                return;
            }

            if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                return;
            }

            // The remote mirror owns the OS session while a target is active.
            if (useRemoteTargetStore.getState().targetDeviceId) {
                return;
            }

            debouncedUpdateMetadata(song);
            // Re-publish position immediately on track change so the OS
            // scrubber jumps to 0 (or wherever the new track starts)
            // instead of holding the previous track's elapsed value.
            if (usePlayerStore.getState().player.status === PlayerStatus.PLAYING) {
                pushPositionState();
            } else {
                clearPositionState();
            }
        });

        const unsubscribeStatus = subscribePlayerStatus(({ status }) => {
            if (!isMediaSessionEnabledRef.current || !mediaSession) {
                return;
            }

            // The remote mirror owns the OS session while a target is active.
            if (useRemoteTargetStore.getState().targetDeviceId) {
                return;
            }

            mediaSession.playbackState = status === PlayerStatus.PLAYING ? 'playing' : 'paused';

            if (status === PlayerStatus.PLAYING) {
                startPositionTicker();
            } else {
                clearPositionState();
            }
        });

        // System-player follows the REMOTE session while a target is picked:
        // the mirrored now-playing (full metadata + controller-loadable cover
        // after queue hydration) and pause state drive the lock-screen /
        // media-key UI. The transport handlers above already route to the
        // remote dispatcher via the player context, so hardware keys control
        // the target; this closes the loop on what the OS *shows*. When the
        // target drops, repaint from the local player.
        const unsubscribeRemote = useRemoteTargetStore.subscribe((s, prev) => {
            if (!isMediaSessionEnabledRef.current || !mediaSession) {
                return;
            }
            const isRemote = s.targetDeviceId !== null;
            const wasRemote = prev.targetDeviceId !== null;
            if (!isRemote && !wasRemote) return;

            if (isRemote) {
                const song = s.mirrored.nowPlayingItem;
                if (!wasRemote || song !== prev.mirrored.nowPlayingItem) {
                    debouncedUpdateMetadata((song ?? undefined) as QueueSong | undefined);
                    clearPositionState();
                }
                const paused = s.mirrored.playState.isPaused;
                if (!wasRemote || paused !== prev.mirrored.playState.isPaused) {
                    mediaSession.playbackState = paused ? 'paused' : 'playing';
                }
                return;
            }

            // Target dropped — hand the OS session back to the local player.
            debouncedUpdateMetadata(usePlayerStore.getState().getCurrentSong());
            const localPlaying = usePlayerStore.getState().player.status === PlayerStatus.PLAYING;
            mediaSession.playbackState = localPlaying ? 'playing' : 'paused';
            if (localPlaying) {
                startPositionTicker();
            } else {
                clearPositionState();
            }
        });

        // If the hook mounts mid-playback (e.g. user toggles the setting
        // on while a song is already playing), kick the ticker so we
        // don't wait for the next status transition.
        if (usePlayerStore.getState().player.status === PlayerStatus.PLAYING) {
            startPositionTicker();
        }

        return () => {
            unsubscribeCurrentSong();
            unsubscribeStatus();
            unsubscribeRemote();
            clearPositionState();
        };
    }, [debouncedUpdateMetadata]);

    // onPlayerRepeated fires via eventEmitter (not Zustand), so usePlayerEvents is safe here —
    // the event emitter uses stable function references for on/off and does not re-subscribe
    // on render. The inline object is fine because deps is [] and the effect only runs once.
    usePlayerEvents(
        {
            onPlayerRepeated: () => {
                if (!isMediaSessionEnabledRef.current) {
                    return;
                }

                if (isRadioActiveRef.current && isRadioPlayingRef.current) {
                    return;
                }

                const currentSong = usePlayerStore.getState().getCurrentSong();
                debouncedUpdateMetadata(currentSong);
            },
        },
        [],
    );
};

const MediaSessionHookInner = () => {
    useMediaSession();
    return null;
};

export const MediaSessionHook = () => {
    // Always render the hook — let the internal guard logic decide whether to act.
    // Conditional rendering here causes unmount/remount cycles that destroy handlers mid-session.
    return React.createElement(MediaSessionHookInner);
};
