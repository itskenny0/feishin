import { useEffect, useRef } from 'react';

import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useIsRadioActive } from '/@/renderer/features/radio/hooks/use-radio-player';
import {
    subscribeCurrentTrack,
    subscribePlayerStatus,
    usePlayerActions,
    useTimestampStoreBase,
} from '/@/renderer/store';
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

type MediaSessionPlugin = typeof import('@jofr/capacitor-media-session').MediaSession;

let pluginPromise: null | Promise<MediaSessionPlugin | null> = null;

const loadPlugin = async (): Promise<MediaSessionPlugin | null> => {
    if (pluginPromise) return pluginPromise;
    pluginPromise = (async () => {
        try {
            const { Capacitor } = await import('@capacitor/core');
            if (!Capacitor.isNativePlatform()) return null;
            const { MediaSession } = await import('@jofr/capacitor-media-session');
            return MediaSession;
        } catch {
            return null;
        }
    })();
    return pluginPromise;
};

const buildMetadata = (song: QueueSong) => {
    const imageUrl = getItemImageUrl({
        id: song.imageId || undefined,
        imageUrl: song.imageUrl,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });
    return {
        album: song.album ?? '',
        artist: song.artistName ?? '',
        artwork: imageUrl ? [{ sizes: '512x512', src: imageUrl, type: 'image/jpeg' }] : [],
        title: song.name ?? '',
    };
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
        let cancelled = false;
        let plugin: MediaSessionPlugin | null = null;
        let positionInterval: null | ReturnType<typeof setInterval> = null;
        let unsubscribeTrack: (() => void) | undefined;
        let unsubscribeStatus: (() => void) | undefined;
        let currentDurationSec = 0;

        const init = async () => {
            const loaded = await loadPlugin();
            if (cancelled || !loaded) return;
            plugin = loaded;

            // Wire transport actions. Radio is gated in-handler rather than
            // skipping registration so the notification still has working
            // play/pause for the radio stream itself.
            await plugin.setActionHandler({ action: 'play' }, () => actionsRef.current.mediaPlay());
            await plugin.setActionHandler({ action: 'pause' }, () =>
                actionsRef.current.mediaPause(),
            );
            await plugin.setActionHandler({ action: 'stop' }, () => actionsRef.current.mediaStop());
            await plugin.setActionHandler({ action: 'nexttrack' }, () => {
                if (isRadioActiveRef.current) return;
                actionsRef.current.mediaNext();
            });
            await plugin.setActionHandler({ action: 'previoustrack' }, () => {
                if (isRadioActiveRef.current) return;
                actionsRef.current.mediaPrevious();
            });
            await plugin.setActionHandler({ action: 'seekto' }, (details) => {
                if (isRadioActiveRef.current) return;
                if (details && typeof details.seekTime === 'number') {
                    actionsRef.current.mediaSeekToTimestamp(details.seekTime);
                }
            });

            // Push current state through immediately so the notification
            // appears the first time the user starts playback (or shows
            // the right state if media was already playing when the hook
            // mounted, which can happen on a hot reload).
            unsubscribeTrack = subscribeCurrentTrack(({ song }) => {
                if (!plugin || !song || isRadioActiveRef.current) return;
                currentDurationSec = (song.duration ?? 0) / 1000;
                plugin.setMetadata(buildMetadata(song));
            });

            // Android 13+ requires POST_NOTIFICATIONS runtime permission
            // before any FGS notification will show. The @jofr plugin
            // doesn't request it on its own, so we have to — and we do it
            // the first time the user actually starts playback (not at
            // app launch) so the OS prompt arrives with obvious context
            // ("I just hit play, this is asking about media controls").
            // The Web `Notification.requestPermission()` API is routed
            // through to the native POST_NOTIFICATIONS dialog by the
            // Capacitor 8 / Chrome WebView.
            let permissionAsked = false;
            const ensureNotificationPermission = () => {
                if (permissionAsked) return;
                permissionAsked = true;
                if (typeof Notification === 'undefined') return;
                if (Notification.permission !== 'default') return;
                // Fire-and-forget; the plugin will start showing the
                // notification as soon as the user accepts. If they
                // deny, the FGS keeps the process alive (background
                // playback still works) — they just won't see the
                // lockscreen / shade controls until they flip the
                // permission in Android settings.
                Notification.requestPermission().catch(() => {});
            };

            unsubscribeStatus = subscribePlayerStatus(({ status }) => {
                if (!plugin) return;
                if (status === PlayerStatus.PLAYING) {
                    ensureNotificationPermission();
                }
                const playbackState =
                    status === PlayerStatus.PLAYING
                        ? 'playing'
                        : status === PlayerStatus.PAUSED
                          ? 'paused'
                          : 'none';
                plugin.setPlaybackState({ playbackState });

                // Manage the position-update ticker around play/pause so
                // we don't waste battery polling while paused or stopped.
                if (positionInterval) {
                    clearInterval(positionInterval);
                    positionInterval = null;
                }
                if (playbackState === 'playing' && currentDurationSec > 0) {
                    positionInterval = setInterval(() => {
                        const position = useTimestampStoreBase.getState().timestamp;
                        plugin
                            ?.setPositionState({
                                duration: currentDurationSec,
                                playbackRate: 1,
                                position,
                            })
                            // Silent — setPositionState can fail when the
                            // duration drifts (e.g. mid-skip) and there's
                            // nothing useful to do besides try again next
                            // tick.
                            .catch(() => {});
                    }, 5000);
                }
            });
        };

        init();

        return () => {
            cancelled = true;
            if (positionInterval) clearInterval(positionInterval);
            unsubscribeTrack?.();
            unsubscribeStatus?.();
            // Clear handlers + state so backgrounding the app and a
            // subsequent hot reload doesn't leave dangling references in
            // the native plugin.
            if (plugin) {
                plugin.setPlaybackState({ playbackState: 'none' }).catch(() => {});
                const actions = [
                    'play',
                    'pause',
                    'stop',
                    'nexttrack',
                    'previoustrack',
                    'seekto',
                ] as const;
                for (const action of actions) {
                    plugin.setActionHandler({ action }, null).catch(() => {});
                }
            }
        };
        // Empty deps — refs above keep the registered handlers current
        // without re-running this effect.
    }, []);
};

export const CapacitorMediaSessionHook = () => {
    useCapacitorMediaSession();
    return null;
};
