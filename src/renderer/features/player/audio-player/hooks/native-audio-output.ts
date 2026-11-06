import type { PluginListenerHandle } from '@capacitor/core';

import { Capacitor, registerPlugin } from '@capacitor/core';

import { logger } from '/@/renderer/utils/logger';

/**
 * Renderer side of the native cat.kenny.feishin.AudioOutputPlugin
 * (android/.../AudioOutputPlugin.java), which forwards
 * AudioManager.ACTION_AUDIO_BECOMING_NOISY: wired headphones unplugged or a
 * Bluetooth / USB audio device disconnected, so audio is about to fall through
 * to the loudspeaker.
 *
 * Android only; elsewhere subscribing is a no-op (desktop / web rely on the
 * mediaDevices devicechange heuristic).
 */
interface AudioOutputPlugin {
    addListener(eventName: 'becomingNoisy', listener: () => void): Promise<PluginListenerHandle>;
}

const isAndroid = Capacitor.getPlatform() === 'android';

// registerPlugin returns a proxy even when no native implementation exists;
// only create it where the plugin ships.
const plugin: AudioOutputPlugin | null = isAndroid
    ? registerPlugin<AudioOutputPlugin>('AudioOutput')
    : null;

/** Subscribe to "audio output is becoming noisy". Returns an unsubscribe. */
export const addBecomingNoisyListener = (listener: () => void): (() => void) => {
    if (!plugin) return () => {};

    let handle: PluginListenerHandle | undefined;
    let removed = false;
    plugin
        .addListener('becomingNoisy', listener)
        .then((h) => {
            if (removed) {
                void h.remove();
            } else {
                handle = h;
                logger.info('[audio-output] listening for becoming-noisy');
            }
        })
        .catch((err: unknown) => {
            logger.warn('[audio-output] could not subscribe to becoming-noisy', { error: err });
        });

    return () => {
        removed = true;
        void handle?.remove();
    };
};
