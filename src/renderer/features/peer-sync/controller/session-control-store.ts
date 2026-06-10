// Transient (never persisted) record of WHO is remote-controlling THIS
// device right now. A device cannot be a remote controller and a remote
// target at the same time: the device picker consults this before letting
// the user pick a target, and the receiver clears any picked target when
// inbound control begins (both sides toast — see peer-receiver and
// device-picker-list).
//
// "Being controlled" is inferred from inbound command activity: every
// applied command stamps the sender + time, and the record expires after a
// quiet period (a controller that walked away shouldn't lock this device
// out of becoming a controller itself forever).

const CONTROL_ACTIVE_WINDOW_MS = 30_000;

let activeControllerPeerId: null | string = null;
let lastCommandAt = 0;

export const recordInboundControl = (peerId: string): void => {
    activeControllerPeerId = peerId;
    lastCommandAt = Date.now();
};

/** The peer currently controlling this device, or null after the quiet period. */
export const getActiveController = (): null | string => {
    if (!activeControllerPeerId) return null;
    if (Date.now() - lastCommandAt > CONTROL_ACTIVE_WINDOW_MS) {
        activeControllerPeerId = null;
        return null;
    }
    return activeControllerPeerId;
};

export const clearActiveController = (): void => {
    activeControllerPeerId = null;
    lastCommandAt = 0;
};
