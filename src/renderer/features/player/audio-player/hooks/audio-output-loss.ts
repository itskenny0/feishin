import { usePlayerStoreBase, useSettingsStore } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

export type AudioOutputLossSource = 'becoming-noisy' | 'device-change';

let lastOutputLossAt = 0;

/** When the private audio output last went away (ms epoch, 0 = never). */
export const getLastAudioOutputLossAt = (): number => lastOutputLossAt;

/**
 * The device's private audio output just went away (headphones unplugged,
 * Bluetooth / USB audio disconnected): pause local playback so it does not
 * continue on the loudspeaker.
 *
 * Uses the player store's own pause action, the one the media notification
 * already drives, so the UI, the media session, the wake lock and any peer
 * state follow exactly as for a tap on pause. Deliberately NOT the
 * remote-routing context action: when this device is only controlling another
 * player, unplugging this device's headphones must not pause that player.
 * DLNA / Jukebox output is not on this device either, so those are left alone.
 *
 * Returns true when it paused.
 */
export const pauseForAudioOutputLoss = (source: AudioOutputLossSource): boolean => {
    lastOutputLossAt = Date.now();

    const playbackType = useSettingsStore.getState().playback.type;
    if (playbackType === PlayerType.DLNA || playbackType === PlayerType.JUKEBOX) {
        return false;
    }

    const player = usePlayerStoreBase.getState();
    if (player.player.status !== PlayerStatus.PLAYING) return false;

    logger.info('[audio-output] output device lost while playing, pausing', { source });
    player.mediaPause();
    return true;
};
