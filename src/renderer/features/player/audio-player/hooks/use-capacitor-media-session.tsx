import { Capacitor } from '@capacitor/core';
import { MediaSession } from '@jofr/capacitor-media-session';
import { useEffect, useRef } from 'react';

import { getCachedThumbnailDataUrl } from '/@/renderer/cache/images';
import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useIsRadioActive } from '/@/renderer/features/radio/hooks/use-radio-player';
import { getIsOnline, subscribeIsOnline } from '/@/renderer/lib/network-status';
import {
    subscribeCurrentTrack,
    subscribePlayerStatus,
    usePlayerActions,
    usePlayerStore,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';

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
 *   - Position state pushed every few seconds while playing — pinning
 *     this to a 5s interval mirrors the cadence the Android Auto reference
 *     apps (zaptrax etc.) settled on; more frequent updates trigger
 *     redundant native bridge round-trips and battery cost.
 *   - Action handlers wired to the same usePlayerActions store the Web
 *     MediaSession hook uses, so play/pause/next/prev/seek from the
 *     notification or lockscreen drive the same code path as in-app
 *     clicks.
 *   - Radio is intentionally not surfaced through the plugin: the
 *     existing Web hook handles radio metadata in-WebView and we
 *     don't have a sensible position/duration story for live streams.
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

// One-shot telemetry toast so we can see on the device whether the
// plugin actually loaded. Without this it was impossible to tell from
// the user's perspective whether the plugin was even imported in the
// shipped APK or silently bailing.
let bootToastShown = false;
const showBootToast = (message: string, kind: 'info' | 'warn' = 'info') => {
    if (bootToastShown) return;
    bootToastShown = true;
    if (kind === 'warn') {
        toast.warn({ message, title: 'Media notification' });
    } else {
        toast.info({ message, title: 'Media notification' });
    }
};

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
    const coverItemId = song.imageId || song.id;
    const cached = coverItemId ? await getCachedThumbnailDataUrl(coverItemId) : null;
    if (cached) {
        imageUrl = cached;
        source = 'cache';
    } else if (getIsOnline()) {
        imageUrl =
            getItemImageUrl({
                id: song.imageId || undefined,
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

        showBootToast('Wiring Android media notification…');

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
                    actionsRef.current.mediaNext();
                });
                await MediaSession.setActionHandler({ action: 'previoustrack' }, () => {
                    if (isRadioActiveRef.current) return;
                    actionsRef.current.mediaPrevious();
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
                // call above throws. Surface a one-time error toast so
                // we can see it on the device rather than silently
                // failing.
                showBootToast(`Media plugin error: ${(err as Error).message ?? 'unknown'}`, 'warn');
                return;
            }
        };

        const unsubscribeTrack = subscribeCurrentTrack(({ song }) => {
            if (isRadioActiveRef.current) return;
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
                return;
            }
            currentDurationSec = (song.duration ?? 0) / 1000;
            setMetadataSafe(song);
        });

        // Coming back ONLINE: refresh metadata so the notification regains
        // the artwork that was withheld while offline (buildMetadata strips
        // it there — the plugin's native artwork download crashes the app
        // when the server is unreachable).
        const unsubscribeOnline = subscribeIsOnline(() => {
            if (!getIsOnline() || isRadioActiveRef.current) return;
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
            const playbackState =
                status === PlayerStatus.PLAYING
                    ? 'playing'
                    : status === PlayerStatus.PAUSED
                      ? 'paused'
                      : 'none';
            MediaSession.setPlaybackState({ playbackState }).catch((err) => {
                showBootToast(
                    `setPlaybackState failed: ${(err as Error).message ?? 'unknown'}`,
                    'warn',
                );
            });

            // Manage the position-update ticker around play/pause so
            // we don't waste battery polling while paused or stopped.
            if (positionInterval) {
                clearInterval(positionInterval);
                positionInterval = null;
            }
            if (playbackState === 'playing' && currentDurationSec > 0) {
                positionInterval = setInterval(() => {
                    const position = useTimestampStoreBase.getState().timestamp;
                    MediaSession.setPositionState({
                        duration: currentDurationSec,
                        playbackRate: 1,
                        position,
                    }).catch(() => {
                        // Silent — setPositionState can fail when the
                        // duration drifts (e.g. mid-skip) and there's
                        // nothing useful to do besides try again next
                        // tick.
                    });
                }, 5000);
            }
        };

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
            if (currentSongNow && !isRadioActiveRef.current) {
                currentDurationSec = (currentSongNow.duration ?? 0) / 1000;
                setMetadataSafe(currentSongNow);
            }
            const status = usePlayerStore.getState().player.status;
            applyStatus(status);
            showBootToast(`Media notification armed (status: ${PlayerStatus[status] ?? status})`);
        });

        return () => {
            if (positionInterval) clearInterval(positionInterval);
            unsubscribeTrack();
            unsubscribeOnline();
            unsubscribeStatus();
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
