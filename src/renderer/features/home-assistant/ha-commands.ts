// Home Assistant → Feishin command receiver. Maps an inbound HA command verb
// (parsed from the cmd topic's last segment) onto a player-store action, reusing
// the same actions peer-receiver does. Never throws on a malformed payload.

import type { HaCommandVerb } from './ha-topics';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

const log = (...a: unknown[]) => console.info('[home-assistant]', ...a);

// Android pins the internal player volume to 100% (see useAndroidForceFullVolume);
// a remote volume set would silently attenuate with no UI to undo it. Mirror
// peer-receiver's guard. Detected async (Capacitor is a lazy import).
let dropVolume = false;
void (async () => {
    try {
        const { Capacitor } = await import('@capacitor/core');
        dropVolume = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
    } catch {
        // Not a Capacitor runtime (Electron / web) — keep volume control.
    }
})();

/** Test-only override for the Android volume guard. */
export const __setHaDropVolumeForTests = (v: boolean): void => {
    dropVolume = v;
};

const asBool = (raw: string): boolean =>
    raw === '1' || raw === 'ON' || raw === 'on' || raw === 'true';

export const applyHaCommand = (verb: HaCommandVerb, raw: string): void => {
    const a = usePlayerStoreBase.getState();
    log('apply cmd', { verb });
    switch (verb) {
        case 'mute': {
            const next = asBool(raw);
            if (a.player.muted !== next) a.mediaToggleMute();
            return;
        }
        case 'next':
            a.mediaNext(false);
            return;
        case 'pause':
            a.mediaPause();
            return;
        case 'play':
            a.mediaPlay();
            return;
        case 'previous':
            a.mediaPrevious(false);
            return;
        case 'repeat': {
            const r =
                raw === 'all'
                    ? PlayerRepeat.ALL
                    : raw === 'one'
                      ? PlayerRepeat.ONE
                      : PlayerRepeat.NONE;
            a.setRepeat(r);
            return;
        }
        case 'seek': {
            const sec = Number(raw);
            if (Number.isFinite(sec)) a.mediaSeekToTimestamp(sec);
            return;
        }
        case 'shuffle':
            a.setShuffle(asBool(raw) ? PlayerShuffle.TRACK : PlayerShuffle.NONE);
            return;
        case 'stop': {
            // No dedicated stop action exists — pause and reset the playhead.
            a.mediaPause();
            a.mediaSeekToTimestamp(0);
            return;
        }
        case 'volume': {
            if (dropVolume) return;
            const v = Number(raw);
            if (Number.isFinite(v)) a.setVolume(v);
            return;
        }
        default:
            return;
    }
};
