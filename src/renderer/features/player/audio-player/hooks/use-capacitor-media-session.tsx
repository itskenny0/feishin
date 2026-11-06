import { Capacitor } from '@capacitor/core';
import { MediaSession } from '@jofr/capacitor-media-session';
import { useEffect, useRef } from 'react';

import { acquireWakeLock, releaseWakeLock } from './native-wake-lock';
import { createWakeLockController } from './wake-lock-controller';

import { getCachedThumbnailDataUrl } from '/@/renderer/cache/images';
import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { useIsRadioActive, useRadioStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { getIsOnline, subscribeIsOnline } from '/@/renderer/lib/network-status';
import {
    subscribeCurrentTrack,
    subscribePlayerSpeed,
    subscribePlayerStatus,
    usePlayerActions,
    usePlayerStore,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';
import { songCoverId } from '/@/shared/utils/song-cover-id';

/**
 * Android background-audio + persistent media notification.
 *
 * Why this file exists in addition to use-media-session.ts:
 *   - The Web Media Session API the existing hook drives is available in
 *     the Capacitor 8 Android WebView, but its lock-screen-notification
 *     integration relies on the WebView keeping audio "active" — which
 *     Android revokes within a minute or two once the app backgrounds.
 *     There's no foreground service holding the process alive.
 *   - @jofr/capacitor-media-session bridges JS calls to a native
 *     MediaSessionCompat + foreground service. Calling setPlaybackState
 *     ({ playbackState: 'playing' }) starts the FGS and posts the
 *     MediaStyle notification; calling 'paused' or 'none' lets it tear
 *     down (the system can then reclaim the process).
 *
 * Wiring:
 *   - Plugin loaded lazily so the web/electron bundles don't pull native
 *     stubs they don't need. Capacitor.isNativePlatform() gates every
 *     code path.
 *   - Metadata refreshed on track change.
 *   - playbackState pushed on every status change (subscribePlayerStatus).
 *   - Position state pushed on every play/pause, track change, seek and
 *     repeat (the lock-screen seekbar extrapolates from the last push, so a
 *     stale one makes it jump), plus every few seconds while playing to
 *     correct drift. 5s mirrors the cadence the Android Auto reference apps
 *     (zaptrax etc.) settled on; more frequent updates trigger redundant
 *     native bridge round-trips and battery cost.
 *   - Action handlers wired to the same usePlayerActions store the Web
 *     MediaSession hook uses, so play/pause/next/prev/seek from the
 *     notification or lockscreen drive the same code path as in-app
 *     clicks.
 *   - Radio: the notification shows the station / stream title with no
 *     seekbar (live streams have no position/duration story); next/prev/
 *     seek are ignored. Without this it kept showing the queue's last song
 *     while the radio played.
 */

// Static import of @jofr/capacitor-media-session. The package ships a
// MediaSessionWeb implementation as the web/iOS fallback (which just
// proxies to navigator.mediaSession), so it's safe to import statically
// even on the electron / browser builds — no native-only code is pulled
// in. Switched away from the previous dynamic import after the build
// log surfaced a "module is both statically and dynamically imported"
// warning and we still couldn't get the notification to appear, raising
// the suspicion that the dynamic chunk wasn't resolving on device.
//
// Gated to Android specifically (not isNativePlatform()): the plugin has
// NO native iOS implementation (its package ships only android/ + a web
// fallback). On iOS, isNativePlatform() is also true, but the plugin would
// resolve to its MediaSessionWeb fallback and double-wire navigator.media
// Session against the dedicated useMediaSession() web hook — which is
// "always on" for non-Electron and already drives the iOS WKWebView lock
// screen. So on iOS we let useMediaSession() own it and this hook stays
// inert. iOS background audio is handled natively via AVAudioSession in
// AppDelegate.swift + the `audio` UIBackgroundMode.
const isAndroid = Capacitor.getPlatform() === 'android';

const buildMetadata = async (song: QueueSong) => {
    // OFFLINE: never hand the native plugin a REMOTE artwork URL. The plugin
    // downloads the artwork natively for the notification; with the server
    // unreachable that native fetch fails and takes the WHOLE APP down to
    // the launcher (device telemetry: every offline crash landed within
    // ~700ms of a song becoming current — playback start or session restore
    // — while the same audio source survived online; no JS error ever
    // preceded death because the crash is on the native side).
    //
    // Instead, serve the CACHED cover as a data: URL — self-contained, so
    // the plugin decodes it locally with no fetch at all. blob:/object URLs
    // won't do: they're renderer-scoped and the native side can't read them.
    let imageUrl: null | string = null;
    let source: 'cache' | 'none' | 'remote' = 'none';
    const coverItemId = songCoverId(song) || song.id;
    const cached = coverItemId ? await getCachedThumbnailDataUrl(coverItemId) : null;
    if (cached) {
        imageUrl = cached;
        source = 'cache';
    } else if (getIsOnline()) {
        imageUrl =
            getItemImageUrl({
                id: songCoverId(song),
                imageUrl: song.imageUrl,
                itemType: LibraryItem.SONG,
                type: 'itemCard',
            }) ?? null;
        source = imageUrl ? 'remote' : 'none';
    }
    console.info('[media-session] setMetadata', {
        artworkBytes: imageUrl ? imageUrl.length : 0,
        songId: song.id,
        source,
    });
    return {
        album: song.album ?? '',
        artist: song.artistName ?? '',
        artwork: imageUrl ? [{ sizes: '512x512', src: imageUrl, type: 'image/jpeg' }] : [],
        title: song.name ?? '',
    };
};

// Guards stale async metadata: only the most recent build may commit, so a
// quick track skip can't paint the previous song's artwork.
let metadataSeq = 0;
const setMetadataSafe = (song: QueueSong): void => {
    metadataSeq += 1;
    const seq = metadataSeq;
    void buildMetadata(song)
        .then((metadata) => {
            if (seq !== metadataSeq) return;
            return MediaSession.setMetadata(metadata);
        })
        .catch(() => {});
};

const setRadioMetadata = (radio: ReturnType<typeof useRadioStore.getState>): void => {
    // Supersede any in-flight song metadata build.
    metadataSeq += 1;
    MediaSession.setMetadata({
        album: '',
        artist: radio.metadata?.artist || '',
        artwork: [],
        title: radio.metadata?.title || radio.stationName || '',
    }).catch(() => {});
    // Duration 0 hides the seekbar left over from the previous song.
    MediaSession.setPositionState({ duration: 0, playbackRate: 1, position: 0 }).catch(() => {});
};

const useCapacitorMediaSession = () => {
    const { mediaNext, mediaPause, mediaPlay, mediaPrevious, mediaSeekToTimestamp, mediaStop } =
        usePlayerActions();
    const isRadioActive = useIsRadioActive();
    const isRadioActiveRef = useRef(isRadioActive);
    isRadioActiveRef.current = isRadioActive;

    // Pin the latest action handlers in a ref so the plugin handlers
    // registered once at mount stay current without unregistering /
    // re-registering on every Zustand action update.
    const actionsRef = useRef({
        mediaNext,
        mediaPause,
        mediaPlay,
        mediaPrevious,
        mediaSeekToTimestamp,
        mediaStop,
    });
    actionsRef.current = {
        mediaNext,
        mediaPause,
        mediaPlay,
        mediaPrevious,
        mediaSeekToTimestamp,
        mediaStop,
    };

    useEffect(() => {
        if (!isAndroid) {
            // On web / electron / iOS the static-imported MediaSession falls
            // back to MediaSessionWeb which just proxies to
            // navigator.mediaSession — already covered by the existing
            // useMediaSession Web hook. Bail to avoid double-wiring. (iOS
            // gets its lock-screen controls from that web hook and its
            // background audio from AVAudioSession in AppDelegate.swift.)
            return;
        }

        let positionInterval: null | ReturnType<typeof setInterval> = null;
        let currentDurationSec = 0;

        // Native partial wake lock keeps the CPU running with the screen off
        // so the WebView's HTML5 <audio> doesn't stall when backgrounded —
        // the foreground media-session service alone doesn't prevent the SoC
        // from suspending on aggressive OEM builds (MIUI/HyperOS, Mi 9T).
        // The controller re-acquires periodically while playing so the native
        // watchdog never lapses mid-session.
        const wakeLock = createWakeLockController({
            acquire: acquireWakeLock,
            release: releaseWakeLock,
        });

        // The notification / lock-screen seekbar extrapolates from the last
        // pushed position, so push on every discontinuity, not just on the
        // periodic tick.
        const pushPositionState = () => {
            if (currentDurationSec <= 0 || useRadioStore.getState().currentStreamUrl) return;
            const timestamp = useTimestampStoreBase.getState().timestamp;
            MediaSession.setPositionState({
                duration: currentDurationSec,
                playbackRate: usePlayerStore.getState().player.speed || 1,
                position: Math.min(Math.max(0, timestamp), currentDurationSec),
            }).catch(() => {
                // Silent: setPositionState can fail when the duration drifts
                // (e.g. mid-skip) and the next push corrects it.
            });
        };

        logger.info('[media-session] wiring Android media notification');

        const init = async () => {
            try {
                await MediaSession.setActionHandler({ action: 'play' }, () =>
                    actionsRef.current.mediaPlay(),
                );
                await MediaSession.setActionHandler({ action: 'pause' }, () =>
                    actionsRef.current.mediaPause(),
                );
                await MediaSession.setActionHandler({ action: 'stop' }, () =>
                    actionsRef.current.mediaStop(),
                );
                await MediaSession.setActionHandler({ action: 'nexttrack' }, () => {
                    if (isRadioActiveRef.current) return;
                    actionsRef.current.mediaNext(false);
                });
                await MediaSession.setActionHandler({ action: 'previoustrack' }, () => {
                    if (isRadioActiveRef.current) return;
                    actionsRef.current.mediaPrevious(false);
                });
                await MediaSession.setActionHandler({ action: 'seekto' }, (details) => {
                    if (isRadioActiveRef.current) return;
                    if (details && typeof details.seekTime === 'number') {
                        actionsRef.current.mediaSeekToTimestamp(details.seekTime);
                    }
                });
            } catch (err) {
                // If the native plugin failed to register (wrong
                // Capacitor version, missing gradle wiring, etc.) every
                // call above throws.
                logger.warn('[media-session] media plugin unavailable', { error: err });
                return;
            }
        };

        const unsubscribeTrack = subscribeCurrentTrack(({ song }) => {
            if (useRadioStore.getState().currentStreamUrl) return;
            if (!song) {
                // Queue cleared / mediaStop — wipe metadata so the
                // lockscreen / notification doesn't keep showing the
                // previous track's artwork after playback ends.
                currentDurationSec = 0;
                MediaSession.setMetadata({
                    album: '',
                    artist: '',
                    artwork: [],
                    title: '',
                }).catch(() => {});
                MediaSession.setPlaybackState({ playbackState: 'none' }).catch(() => {});
                // Hard stop: no track is current, so nothing needs the CPU
                // pinned awake. Release immediately (cancels any pending
                // grace-period release too).
                wakeLock.releaseNow();
                return;
            }
            currentDurationSec = (song.duration ?? 0) / 1000;
            setMetadataSafe(song);
            // New duration + reset position now, instead of letting the
            // seekbar run on with the previous track's numbers until the
            // next tick.
            pushPositionState();
        });

        eventEmitter.on('PLAYER_SEEK_TO_TIMESTAMP', pushPositionState);
        eventEmitter.on('PLAYER_REPEATED', pushPositionState);

        const unsubscribeRadio = useRadioStore.subscribe((radio, prev) => {
            if (radio.currentStreamUrl) {
                if (
                    radio.currentStreamUrl !== prev.currentStreamUrl ||
                    radio.metadata !== prev.metadata ||
                    radio.stationName !== prev.stationName
                ) {
                    setRadioMetadata(radio);
                }
                return;
            }
            if (!prev.currentStreamUrl) return;
            // Radio dismissed: back to the queue's current track.
            const song = usePlayerStore.getState().getCurrentSong();
            if (!song) return;
            currentDurationSec = (song.duration ?? 0) / 1000;
            setMetadataSafe(song);
            pushPositionState();
        });

        // Coming back ONLINE: refresh metadata so the notification regains
        // the artwork that was withheld while offline (buildMetadata strips
        // it there — the plugin's native artwork download crashes the app
        // when the server is unreachable).
        const unsubscribeOnline = subscribeIsOnline(() => {
            if (!getIsOnline() || useRadioStore.getState().currentStreamUrl) return;
            const song = usePlayerStore.getState().getCurrentSong();
            if (song) {
                setMetadataSafe(song);
            }
        });

        // Android 13+ requires POST_NOTIFICATIONS at runtime. The plugin
        // doesn't request it on its own; we trigger the prompt the first
        // time playback transitions to PLAYING so the OS dialog arrives
        // with obvious context. Capacitor's WebView routes the Web
        // Notification.requestPermission() call to the native
        // POST_NOTIFICATIONS dialog.
        let permissionAsked = false;
        const ensureNotificationPermission = () => {
            if (permissionAsked) return;
            permissionAsked = true;
            if (typeof Notification === 'undefined') return;
            if (Notification.permission !== 'default') return;
            Notification.requestPermission().catch(() => {});
        };

        const applyStatus = (status: PlayerStatus) => {
            if (status === PlayerStatus.PLAYING) {
                ensureNotificationPermission();
            }
            // Hold/release the native partial wake lock around play/pause so
            // background audio doesn't stall when the screen turns off.
            wakeLock.apply(status);
            const playbackState =
                status === PlayerStatus.PLAYING
                    ? 'playing'
                    : status === PlayerStatus.PAUSED
                      ? 'paused'
                      : 'none';
            MediaSession.setPlaybackState({ playbackState }).catch((err) => {
                logger.warn('[media-session] setPlaybackState failed', {
                    error: err,
                    playbackState,
                });
            });
            // Pin the exact play/pause position; the last periodic push can be
            // up to one tick old, which made the paused seekbar jump back.
            if (playbackState !== 'none') pushPositionState();

            // Manage the position-update ticker around play/pause so
            // we don't waste battery polling while paused or stopped.
            if (positionInterval) {
                clearInterval(positionInterval);
                positionInterval = null;
            }
            if (playbackState === 'playing') {
                positionInterval = setInterval(pushPositionState, 5000);
            }
        };

        // Playback speed changes how fast the lock-screen seekbar should run.
        const unsubscribeSpeed = subscribePlayerSpeed(pushPositionState);

        const unsubscribeStatus = subscribePlayerStatus(({ status }) => applyStatus(status));

        init().then(() => {
            // Prime the plugin with whatever the player is doing
            // *right now* — Zustand subscribers only fire on changes,
            // so a song that was already playing when this hook mounted
            // would otherwise leave the plugin in its default 'none'
            // state forever. Surface the priming result via the boot
            // toast so we can confirm on the device that we got past
            // this step.
            const currentSongNow = usePlayerStore.getState().getCurrentSong();
            const radioNow = useRadioStore.getState();
            if (radioNow.currentStreamUrl) {
                setRadioMetadata(radioNow);
            } else if (currentSongNow) {
                currentDurationSec = (currentSongNow.duration ?? 0) / 1000;
                setMetadataSafe(currentSongNow);
            }
            const status = usePlayerStore.getState().player.status;
            applyStatus(status);
            logger.info('[media-session] media notification armed', { status });
        });

        return () => {
            if (positionInterval) clearInterval(positionInterval);
            // Never leak a held CPU wake lock across an unmount / hot reload.
            wakeLock.dispose();
            unsubscribeTrack();
            unsubscribeOnline();
            unsubscribeStatus();
            unsubscribeSpeed();
            unsubscribeRadio();
            eventEmitter.off('PLAYER_SEEK_TO_TIMESTAMP', pushPositionState);
            eventEmitter.off('PLAYER_REPEATED', pushPositionState);
            // Clear handlers + state so backgrounding the app and a
            // subsequent hot reload doesn't leave dangling references in
            // the native plugin.
            MediaSession.setPlaybackState({ playbackState: 'none' }).catch(() => {});
            for (const action of [
                'play',
                'pause',
                'stop',
                'nexttrack',
                'previoustrack',
                'seekto',
            ] as const) {
                MediaSession.setActionHandler({ action }, null).catch(() => {});
            }
        };
        // Refs above keep the registered handlers current without
        // re-running this effect.
    }, []);
};

export const CapacitorMediaSessionHook = () => {
    useCapacitorMediaSession();
    return null;
};
