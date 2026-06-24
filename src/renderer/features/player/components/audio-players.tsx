import isElectron from 'is-electron';
import { lazy, Suspense, useEffect } from 'react';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { UserFavoriteEventPayload, UserRatingEventPayload } from '/@/renderer/events/events';
import { DiscordRpcHook } from '/@/renderer/features/discord-rpc/use-discord-rpc';
import { JellyfinRemoteControlHook } from '/@/renderer/features/jellyfin-remote-control';
import { SessionsPollerHook } from '/@/renderer/features/jellyfin-remote-target/hooks/use-sessions-poller';
import { UpcomingLyricsPrefetch } from '/@/renderer/features/lyrics/hooks/use-prefetch-upcoming-lyrics';
import { CapacitorMediaSessionHook } from '/@/renderer/features/player/audio-player/hooks/use-capacitor-media-session';
import { MainPlayerListenerHook } from '/@/renderer/features/player/audio-player/hooks/use-main-player-listener';
import { PauseOnDeviceDisconnectHook } from '/@/renderer/features/player/audio-player/hooks/use-pause-on-device-disconnect';
import { MpvPlayer } from '/@/renderer/features/player/audio-player/mpv-player';
import { WebPlayer } from '/@/renderer/features/player/audio-player/web-player';
import { SleepTimerHook } from '/@/renderer/features/player/components/sleep-timer-button';
import { AutoDJHook } from '/@/renderer/features/player/hooks/use-auto-dj';
import { AutosaveHook } from '/@/renderer/features/player/hooks/use-autosave';
import { MediaSessionHook } from '/@/renderer/features/player/hooks/use-media-session';
import { MPRISHook } from '/@/renderer/features/player/hooks/use-mpris';
import { PlaybackHotkeysHook } from '/@/renderer/features/player/hooks/use-playback-hotkeys';
import { PowerSaveBlockerHook } from '/@/renderer/features/player/hooks/use-power-save-blocker';
import { UpcomingCoversPrefetch } from '/@/renderer/features/player/hooks/use-prefetch-upcoming-covers';
import {
    InitialTimestampRestoreHook,
    QueueRestoreTimestampHook,
} from '/@/renderer/features/player/hooks/use-queue-restore';
import { ScrobbleHook } from '/@/renderer/features/player/hooks/use-scrobble';
import { UpdateCurrentSongHook } from '/@/renderer/features/player/hooks/use-update-current-song';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import { RadioWebPlayer } from '/@/renderer/features/radio/components/radio-web-player';
import {
    RadioAudioInstanceHook,
    RadioMetadataHook,
    useIsRadioActive,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { RemoteHook } from '/@/renderer/features/remote/hooks/use-remote';
import { VisualizerSystemAudioBridgeHook } from '/@/renderer/features/visualizer/components/visualizer-system-audio-bridge';
import {
    updateQueueFavorites,
    updateQueueRatings,
    useCurrentServerId,
    usePlaybackSettings,
    usePlaybackType,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { logFn } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';
import { PlayerType, WebAudio } from '/@/shared/types/types';

// The peer-sync subsystem statically pulls in the MQTT client (`mqtt` + its
// `mqtt-packet`/`number-allocator` deps, ~360 KB of parsed JS). Loading it
// lazily keeps that graph out of the renderer ENTRY chunk. We go one step
// further than a bare React.lazy: the chunk is only fetched once the user has
// actually completed the Connect wizard (peerSync.enabled + jellyfinRemoteEnabled
// + onboarded). For the common case — a user who never touches Connect — the
// MQTT chunk is NEVER downloaded, so it stops counting toward startup JS.
//
// `usePeerSync`'s effects all no-op when those preconditions are false, so
// nothing meaningful is lost by withholding the mount; flipping any of them
// true mounts the hook and wires the subsystem, and flipping one false unmounts
// it (running its `stopPeerClient` teardown). `null` fallback — the hook renders
// nothing, so there is no UI to flash.
const LazyPeerSyncHook = lazy(() =>
    import('/@/renderer/features/peer-sync').then((module) => ({
        default: module.PeerSyncHook,
    })),
);

const PeerSyncMount = () => {
    const peerSyncActive = useSettingsStore(
        (state) =>
            state.peerSync.enabled &&
            state.peerSync.jellyfinRemoteEnabled &&
            state.peerSync.onboarded,
    );
    // A configured-but-gated install is invisible without this: broker
    // settings persist (the settings UI looks ready) while the subsystem
    // never mounts. Log WHICH flag is holding it down — this is how the
    // iPod-vs-phone "devices don't see each other" hunt (2026-06-10) was
    // diagnosed, and the log keeps the next regression diagnosable from
    // device telemetry alone.
    useEffect(() => {
        if (peerSyncActive) return;
        const { peerSync } = useSettingsStore.getState();
        if (!peerSync.enabled && !peerSync.brokerUrl) return; // never configured
        console.warn('[peer-sync] configured but inactive — not mounting', {
            enabled: peerSync.enabled,
            jellyfinRemoteEnabled: peerSync.jellyfinRemoteEnabled,
            onboarded: peerSync.onboarded,
        });
    }, [peerSyncActive]);

    if (!peerSyncActive) return null;

    return (
        <Suspense fallback={null}>
            <LazyPeerSyncHook />
        </Suspense>
    );
};

// Home Assistant MQTT bridge. Lazily mounted so the mqtt/bridge code stays out
// of the main bundle until the user enables it. Gated only on the HA toggle +
// a configured broker — independent of peer-sync's own enable flags.
const LazyHomeAssistantHook = lazy(() =>
    import('/@/renderer/features/home-assistant').then((module) => ({
        default: module.HomeAssistantHook,
    })),
);

const HomeAssistantMount = () => {
    const haActive = useSettingsStore(
        (state) =>
            state.peerSync.homeAssistant?.enabled === true &&
            Boolean(state.peerSync.brokerUrl?.trim()),
    );

    if (!haActive) return null;

    return (
        <Suspense fallback={null}>
            <LazyHomeAssistantHook />
        </Suspense>
    );
};

// Android background-sync foreground service. Lazily mounted so the native
// bridge code stays out of the main bundle until the cache is enabled. The hook
// itself no-ops off Android-native, but we also gate the mount on the cache +
// background-sync settings so the chunk isn't fetched on installs that never
// use it.
const LazySyncForegroundServiceHook = lazy(() =>
    import('/@/renderer/features/sync-service').then((module) => ({
        default: module.SyncForegroundServiceHook,
    })),
);

const SyncForegroundServiceMount = () => {
    const active = useSettingsStore(
        (state) =>
            state.localCache?.enabled === true &&
            state.localCache?.android?.backgroundSync !== false,
    );

    if (!active) return null;

    return (
        <Suspense fallback={null}>
            <LazySyncForegroundServiceHook />
        </Suspense>
    );
};

const CODEC_PROBES = [
    { codec: 'mp3', container: 'mp3', mime: 'audio/mpeg' },

    { codec: 'aac', container: 'mp4', mime: 'audio/mp4; codecs="mp4a.40.2"' },
    { codec: 'aac', container: 'aac', mime: 'audio/aac' },
    { codec: 'aac', container: 'mp4', mime: 'audio/x-m4a' },

    { codec: 'opus', container: 'ogg', mime: 'audio/ogg; codecs="opus"' },
    { codec: 'opus', container: 'webm', mime: 'audio/webm; codecs="opus"' },

    { codec: 'vorbis', container: 'ogg', mime: 'audio/ogg; codecs="vorbis"' },
    { codec: 'vorbis', container: 'webm', mime: 'audio/webm; codecs="vorbis"' },

    { codec: 'flac', container: 'flac', mime: 'audio/flac' },

    { codec: ['pcm', 'wav'], container: 'wav', mime: 'audio/wav' },

    { codec: 'alac', container: 'mp4', mime: 'audio/mp4; codecs="alac"' },
];

const DEFAULT_TRANSCODING_PROFILES = [
    { audioCodec: 'flac', container: 'flac', protocol: 'http' },
    { audioCodec: 'opus', container: 'ogg', protocol: 'http' },
    { audioCodec: 'mp3', container: 'mp3', protocol: 'http' },
];

const SAFARI_TRANSCODING_PROFILES = [{ audioCodec: 'mp3', container: 'mp3', protocol: 'http' }];

const DIRECT_PLAY_PROFILES: {
    audioCodecs: string[];
    containers: string[];
    protocols: string[];
}[] = [];

export function getDefaultTranscodingProfiles() {
    return isSafari() ? SAFARI_TRANSCODING_PROFILES : DEFAULT_TRANSCODING_PROFILES;
}

export function getDirectPlayProfiles() {
    return DIRECT_PLAY_PROFILES;
}

// Shamelessly taken from NavidromeUI
function detectBrowserProfile() {
    const audio = new Audio();

    for (const { codec, container, mime } of CODEC_PROBES) {
        if (audio.canPlayType(mime) === 'maybe' || audio.canPlayType(mime) === 'probably') {
            DIRECT_PLAY_PROFILES.push({
                audioCodecs: Array.isArray(codec) ? codec : [codec],
                containers: [container],
                protocols: ['http'],
            });
        }
    }

    logFn.info('DIRECT_PLAY_PROFILES', { meta: DIRECT_PLAY_PROFILES });

    return DIRECT_PLAY_PROFILES;
}

function isSafari() {
    const ua = navigator.userAgent;
    return ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium');
}

export const AudioPlayers = () => {
    const playbackType = usePlaybackType();
    const serverId = useCurrentServerId();
    const { resetSampleRate } = useSettingsStoreActions();

    const {
        audioDeviceId,
        mpvProperties: { audioSampleRateHz },
        webAudio,
    } = usePlaybackSettings();
    const { setWebAudio, webAudio: audioContext } = useWebAudio();

    useEffect(() => {
        detectBrowserProfile();
    }, []);

    return (
        <>
            <SleepTimerHook />
            <ScrobbleHook />
            <PowerSaveBlockerHook />
            <DiscordRpcHook />
            <MPRISHook />
            <MainPlayerListenerHook />
            <PauseOnDeviceDisconnectHook />
            <MediaSessionHook />
            <CapacitorMediaSessionHook />
            <PlaybackHotkeysHook />
            <RemoteHook />
            <JellyfinRemoteControlHook />
            <SessionsPollerHook />
            <PeerSyncMount />
            <HomeAssistantMount />
            <SyncForegroundServiceMount />
            <AutoDJHook />
            <UpcomingLyricsPrefetch />
            <UpcomingCoversPrefetch />
            <QueueRestoreTimestampHook />
            <InitialTimestampRestoreHook />
            <UpdateCurrentSongHook />
            <RadioAudioInstanceHook />
            <RadioMetadataHook />
            <VisualizerSystemAudioBridgeHook />
            <AutosaveHook />
            <AudioPlayersContent
                audioContext={audioContext}
                audioDeviceId={audioDeviceId}
                audioSampleRateHz={audioSampleRateHz}
                playbackType={playbackType}
                resetSampleRate={resetSampleRate}
                serverId={serverId}
                setWebAudio={setWebAudio}
                webAudio={webAudio}
            />
        </>
    );
};

const AudioPlayersContent = ({
    audioContext,
    audioDeviceId,
    audioSampleRateHz,
    playbackType,
    resetSampleRate,
    serverId,
    setWebAudio,
    webAudio,
}: {
    audioContext: ReturnType<typeof useWebAudio>['webAudio'];
    audioDeviceId: null | string | undefined;
    audioSampleRateHz: number | undefined;
    playbackType: PlayerType;
    resetSampleRate: ReturnType<typeof useSettingsStoreActions>['resetSampleRate'];
    serverId: null | string;
    setWebAudio: ReturnType<typeof useWebAudio>['setWebAudio'];
    webAudio: boolean;
}) => {
    const isRadioActive = useIsRadioActive();

    useEffect(() => {
        if (!webAudio || !('AudioContext' in window)) {
            return;
        }

        let context: AudioContext;

        try {
            context = new AudioContext({
                latencyHint: 'playback',
                sampleRate: audioSampleRateHz || undefined,
            });
        } catch (error) {
            // In practice, this should never be hit because the UI should validate
            // the range. However, the actual supported range is not guaranteed
            toast.error({ message: (error as Error).message });
            context = new AudioContext({ latencyHint: 'playback' });
            resetSampleRate();
        }

        const gains = [context.createGain(), context.createGain()];

        // Build DSP chain from persisted settings so EQ/compressor
        // are active immediately on first playback, not just after
        // the user opens the settings panel.
        const { compressor, equalizer } = useSettingsStore.getState().playback;

        // Preamp gain — converts dB to linear
        const preampGain = context.createGain();
        preampGain.gain.value = equalizer.enabled ? Math.pow(10, equalizer.preamp / 20) : 1;

        // One peaking BiquadFilterNode per EQ band
        const eqFilters: BiquadFilterNode[] = equalizer.bands.map((band) => {
            const filter = context.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = band.freq;
            // Q of 1.41 gives roughly 1-octave bandwidth per band
            filter.Q.value = 1.41;
            filter.gain.value = equalizer.enabled ? band.gain : 0;
            return filter;
        });

        // DynamicsCompressorNode — always present, pass-through when disabled
        // (ratio=1, threshold=0 = mathematically transparent)
        const compressorNode = context.createDynamicsCompressor();
        if (compressor.enabled) {
            compressorNode.threshold.value = compressor.threshold;
            compressorNode.ratio.value = compressor.ratio;
            compressorNode.attack.value = compressor.attack / 1000;
            compressorNode.release.value = compressor.release / 1000;
            compressorNode.knee.value = compressor.knee;
        } else {
            compressorNode.threshold.value = 0;
            compressorNode.ratio.value = 1;
            compressorNode.attack.value = 0;
            compressorNode.release.value = 0.25;
            compressorNode.knee.value = 0;
        }

        // Wire: each gain → preamp → eq[0] → eq[1] → ... → compressor → destination
        for (const gain of gains) {
            gain.connect(preampGain);
        }

        if (eqFilters.length > 0) {
            preampGain.connect(eqFilters[0]);
            for (let i = 0; i < eqFilters.length - 1; i++) {
                eqFilters[i].connect(eqFilters[i + 1]);
            }
            eqFilters[eqFilters.length - 1].connect(compressorNode);
        } else {
            preampGain.connect(compressorNode);
        }

        compressorNode.connect(context.destination);

        setWebAudio!({
            context,
            dsp: { compressor: compressorNode, eqFilters, preampGain },
            gains,
        });

        return () => {
            // Tear down the context promptly when the component unmounts
            // or when the user toggles WebAudio off — letting it linger
            // keeps an audio thread alive and (on Chromium) prevents the
            // tab from going fully idle.
            try {
                for (const gain of gains) {
                    try {
                        gain.disconnect();
                    } catch {
                        // gain may already be detached
                    }
                }
                if (context.state !== 'closed') {
                    // AudioContext.close() is async and can reject if the
                    // context is already closed; we don't want to block
                    // cleanup on it, so fire-and-forget with a swallow.
                    context.close().catch(() => {});
                }
            } catch {
                // Some WebViews stub close() — nothing meaningful to do.
            }
            // The context type narrows to WebAudio, but the underlying
            // useState in app.tsx accepts undefined — cast through any
            // to clear the slot so downstream subscribers see the
            // teardown rather than a stale closed-context handle.
            (setWebAudio as unknown as (audio: undefined | WebAudio) => void)(undefined);
        };

        // Intentionally ignore the sample rate dependency, as it makes things really messy
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [webAudio]);

    useEffect(() => {
        // Not standard, just used in chromium-based browsers. See
        // https://developer.chrome.com/blog/audiocontext-setsinkid/.

        if (!isElectron()) {
            return;
        }

        if (playbackType !== PlayerType.WEB) {
            return;
        }

        if (audioContext && 'setSinkId' in audioContext.context && audioDeviceId) {
            const setSink = async () => {
                try {
                    if (audioContext.context.state !== 'closed') {
                        await (
                            audioContext.context as AudioContext & {
                                setSinkId: (sinkId: string) => Promise<void>;
                            }
                        ).setSinkId(audioDeviceId);
                    }
                } catch (error) {
                    toast.error({ message: `Error setting sink: ${(error as Error).message}` });
                }
            };

            setSink();
        }
    }, [audioContext, audioDeviceId, playbackType]);

    // Listen to favorite and rating events to update queue songs
    useEffect(() => {
        const handleFavorite = (payload: UserFavoriteEventPayload) => {
            if (payload.itemType !== LibraryItem.SONG || payload.serverId !== serverId) {
                return;
            }

            updateQueueFavorites(payload.id, payload.favorite);
        };

        const handleRating = (payload: UserRatingEventPayload) => {
            if (payload.itemType !== LibraryItem.SONG || payload.serverId !== serverId) {
                return;
            }

            updateQueueRatings(payload.id, payload.rating);
        };

        eventEmitter.on('USER_FAVORITE', handleFavorite);
        eventEmitter.on('USER_RATING', handleRating);

        return () => {
            eventEmitter.off('USER_FAVORITE', handleFavorite);
            eventEmitter.off('USER_RATING', handleRating);
        };
    }, [serverId]);

    if (isRadioActive && playbackType === PlayerType.LOCAL) {
        return <MpvPlayer />;
    }

    if (isRadioActive && playbackType === PlayerType.WEB) {
        return <RadioWebPlayer />;
    }

    return (
        <>
            {playbackType === PlayerType.WEB && <WebPlayer />}
            {playbackType === PlayerType.LOCAL && <MpvPlayer />}
        </>
    );
};
