/**
 * Transport selector.
 *
 * The dispatcher used to assume Jellyfin was the only path to the remote
 * peer. Now it asks this module which transport is alive for a given peer
 * right now, and publishes through that one. The selector is the single
 * decision point so the answer never disagrees between dispatcher and
 * state-mirror.
 *
 * Decision is presence-driven: when an MQTT presence frame from the peer is
 * recent (within `MQTT_PRESENCE_TTL_MS`), MQTT is the chosen lane.
 * Otherwise we fall back to Jellyfin Sessions polling. The flip is logged.
 *
 * Implemented as a tiny observable so the dispatcher can publish via the
 * current lane synchronously and the mirror can switch input sources when
 * the lane flips.
 */
import type { TransportKind } from '/@/renderer/features/peer-sync/types';

/** Window in which a peer's presence frame counts as "fresh". */
export const MQTT_PRESENCE_TTL_MS = 12_000;

interface PeerPresenceRecord {
    /** epoch ms when we last saw this peer announce online. */
    lastSeenAt: number;
    /** explicit offline (LWT) — overrides freshness. */
    online: boolean;
}

interface TransportSelectorState {
    /** Per-peerId presence records. */
    presence: Map<string, PeerPresenceRecord>;
    /** True when the user has flipped the master Peer Sync toggle on. */
    syncEnabled: boolean;
}

type Listener = (peerId: string, kind: TransportKind) => void;

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

const state: TransportSelectorState = {
    presence: new Map(),
    syncEnabled: false,
};

const lastChosen = new Map<string, TransportKind>();
const listeners = new Set<Listener>();

const isFresh = (rec: PeerPresenceRecord, now: number): boolean =>
    rec.online && now - rec.lastSeenAt < MQTT_PRESENCE_TTL_MS;

/**
 * Choose the transport for `peerId` right now. Pure read — does not flip
 * any observers; callers use `subscribe` for change notifications.
 */
export const pickTransport = (peerId: string, now: number = Date.now()): TransportKind => {
    if (!state.syncEnabled) return 'jellyfin';
    const rec = state.presence.get(peerId);
    if (!rec) return 'jellyfin';
    return isFresh(rec, now) ? 'mqtt' : 'jellyfin';
};

const notifyIfChanged = (peerId: string, now: number): void => {
    const next = pickTransport(peerId, now);
    const prev = lastChosen.get(peerId);
    if (prev === next) return;
    lastChosen.set(peerId, next);
    if (prev !== undefined) {
        log('transport flip', { from: prev, peerId, to: next });
    }
    for (const l of listeners) l(peerId, next);
};

/** Record a presence frame for `peerId`. */
export const recordPresence = (peerId: string, online: boolean, now: number = Date.now()): void => {
    state.presence.set(peerId, { lastSeenAt: now, online });
    notifyIfChanged(peerId, now);
};

/**
 * Forget a peer entirely — e.g. when the user clears the target or the
 * client disconnects.
 */
export const forgetPeer = (peerId: string): void => {
    state.presence.delete(peerId);
    const prev = lastChosen.get(peerId);
    lastChosen.delete(peerId);
    if (prev !== undefined && prev !== 'jellyfin') {
        log('transport flip', { from: prev, peerId, to: 'jellyfin' });
        for (const l of listeners) l(peerId, 'jellyfin');
    }
};

/**
 * Toggle the master enable. When flipped off all peers immediately fall
 * back to the Jellyfin lane.
 */
export const setSyncEnabled = (enabled: boolean): void => {
    if (state.syncEnabled === enabled) return;
    state.syncEnabled = enabled;
    log('sync enabled', { enabled });
    const now = Date.now();
    // Re-evaluate every peer we know about so observers see the flip.
    for (const peerId of state.presence.keys()) notifyIfChanged(peerId, now);
};

/** Whether the master toggle is currently on. */
export const isSyncEnabled = (): boolean => state.syncEnabled;

/**
 * Force-recompute every known peer's transport — used by the presence
 * sweeper interval below so stale presence ages out within one tick.
 */
export const sweepStalePresence = (now: number = Date.now()): void => {
    for (const peerId of state.presence.keys()) notifyIfChanged(peerId, now);
};

/** Subscribe to transport flips. Returns an unsubscribe function. */
export const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** Reset everything — used by tests. */
export const __resetForTests = (): void => {
    state.presence.clear();
    state.syncEnabled = false;
    lastChosen.clear();
    listeners.clear();
};
