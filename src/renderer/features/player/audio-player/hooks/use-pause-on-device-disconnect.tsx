import { useEffect, useRef } from 'react';

import { usePlayerActions, usePlayerStatus } from '/@/renderer/store';
import { PlayerStatus } from '/@/shared/types/types';

/**
 * Auto-pause when the active audio output device disappears.
 *
 * Browsers / WebViews don't stop playback when a Bluetooth or wired
 * headphone is removed mid-song — they reroute to the next available
 * output (usually the loudspeaker). Without intervention this dumps
 * whatever was playing into the open, which is the platform anti-pattern
 * every native music app guards against.
 *
 * We listen to `navigator.mediaDevices.devicechange`, compare the new
 * audiooutput list to the previous snapshot, and pause if any device
 * was removed while playback was active. This catches:
 *   - Bluetooth disconnect (peripheral powers down, drifts out of range)
 *   - Wired headphones unplugged
 *   - USB DAC unplugged
 *
 * The `removed.length > 0` check is the simplest reliable heuristic —
 * we can't always know which device the system was actively routing to
 * (the "default" sinkId is opaque), so any contraction of the device
 * list while playing is treated as "the user just lost their listening
 * surface, pause." False positives (pausing when an unrelated USB
 * peripheral is unplugged) are rare and far less harmful than the
 * default behaviour of blasting audio at strangers.
 */
const usePauseOnDeviceDisconnect = () => {
    const { mediaPause } = usePlayerActions();
    const status = usePlayerStatus();
    // Stash the latest status in a ref so the device-change handler
    // (registered once) can read it without re-binding on every play/pause.
    const statusRef = useRef(status);
    statusRef.current = status;

    useEffect(() => {
        const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
        if (!md || typeof md.addEventListener !== 'function') return;

        let previousOutputs = new Set<string>();

        const snapshot = async () => {
            try {
                const devices = await md.enumerateDevices();
                previousOutputs = new Set(
                    devices.filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId),
                );
            } catch {
                // enumerateDevices can throw when called before any
                // device permission has been granted (Safari, locked-down
                // WebViews). Silent — we'll just have an empty baseline
                // and the first devicechange will populate it.
            }
        };

        const handler = async () => {
            let current: Set<string>;
            try {
                const devices = await md.enumerateDevices();
                current = new Set(
                    devices.filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId),
                );
            } catch {
                return;
            }

            const removed = [...previousOutputs].filter((id) => !current.has(id));
            previousOutputs = current;

            if (removed.length === 0) return;
            if (statusRef.current !== PlayerStatus.PLAYING) return;

            mediaPause();
        };

        snapshot();
        md.addEventListener('devicechange', handler);
        return () => {
            md.removeEventListener('devicechange', handler);
        };
    }, [mediaPause]);
};

export const PauseOnDeviceDisconnectHook = () => {
    usePauseOnDeviceDisconnect();
    return null;
};
