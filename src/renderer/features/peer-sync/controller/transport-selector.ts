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
 * The picker UI talks in Jellyfin Sessions deviceIds — a server-generated
 * id from the `/Sessions` response — but the dispatcher routes by MQTT
 * peerId. The two id spaces never matched before, so even when both peers
 * had MQTT happily online the picker always read lane='jellyfin'. To bridge
 * them, each peer carries its own Jellyfin deviceId in the published
 * presence frame, and the selector maintains a parallel `jfDeviceId -> peerId`
 * map. `pickTransportByJellyfinDeviceId` resolves the bridge in one call.
 *
 * Implemented as a tiny observable so the dispatcher can publish via the
 * current lane synchronously and the mirror can switch input sources when
 * the lane flips.
 */
import type { TransportKind } from '/@/renderer/features/peer-sync/types';

/** Window in which a peer's presence frame counts as "fresh". */
export const MQTT_PRESENCE_TTL_MS = 12_000;

type Listener = (peerId: string, kind: TransportKind) => void;

interface PeerPresenceRecord {
    /** Publisher's Jellyfin Sessions deviceId, when carried on the wire.
     *  Used to bridge a picker row (keyed on Jellyfin deviceId) back to its
     *  MQTT peer. Optional: older publishers omit it. */
    jellyfinDeviceId?: string;
    /** epoch ms when we last saw this peer announce online. */
    lastSeenAt: number;
    /** explicit offline (LWT) — overrides freshness. */
    online: boolean;
}

interface TransportSelectorState {
    /** `jellyfinDeviceId -> peerId` reverse index built from presence
     *  frames. Last-writer-wins on collision. */
    jfDeviceIdToPeerId: Map<string, string>;
    /** Per-peerId presence records. */
    presence: Map<string, PeerPresenceRecord>;
    /** True when the user has flipped the master Peer Sync toggle on. */
    syncEnabled: boolean;
}

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

const state: TransportSelectorState = {
    jfDeviceIdToPeerId: new Map(),
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

/**
 * Look up the MQTT peerId for a Jellyfin Sessions deviceId. Returns
 * undefined when no peer has claimed this deviceId (older publishers,
 * jellyfin-web sessions, peers we haven't received presence for yet).
 */
export const getPeerIdForJellyfinDeviceId = (jellyfinDeviceId: string): string | undefined => {
    if (!jellyfinDeviceId) return undefined;
    return state.jfDeviceIdToPeerId.get(jellyfinDeviceId);
};

/**
 * PeerIds with fresh presence right now — same freshness semantics as
 * `pickTransport` (online + within `MQTT_PRESENCE_TTL_MS`). The mirror's
 * "unbridged target" gate uses this to accept a frame only when exactly one
 * peer is unambiguously live, instead of failing open to any peer.
 */
export const getFreshPeerIds = (now: number = Date.now()): string[] => {
    const out: string[] = [];
    for (const [peerId, rec] of state.presence) {
        if (isFresh(rec, now)) out.push(peerId);
    }
    return out;
};

/**
 * Convenience: pick the transport for a Jellyfin Sessions deviceId by
 * resolving through the bridge. Returns 'jellyfin' when the deviceId has
 * no known MQTT peer or sync is disabled.
 */
export const pickTransportByJellyfinDeviceId = (
    jellyfinDeviceId: string,
    now: number = Date.now(),
): TransportKind => {
    const peerId = getPeerIdForJellyfinDeviceId(jellyfinDeviceId);
    if (!peerId) return 'jellyfin';
    return pickTransport(peerId, now);
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

/**
 * Record a presence frame for `peerId`. When `jellyfinDeviceId` is supplied
 * the reverse map is updated so the picker can bridge from a Jellyfin row
 * to this peer.
 */
export const recordPresence = (
    peerId: string,
    online: boolean,
    now: number = Date.now(),
    jellyfinDeviceId?: string,
): void => {
    const prev = state.presence.get(peerId);
    // If this peer was previously bound to a *different* jellyfinDeviceId,
    // clear the stale reverse entry — but only when it still points to us
    // (another peer may have since claimed the same deviceId, in which case
    // we don't want to clobber the new mapping).
    if (prev?.jellyfinDeviceId && prev.jellyfinDeviceId !== jellyfinDeviceId) {
        if (state.jfDeviceIdToPeerId.get(prev.jellyfinDeviceId) === peerId) {
            state.jfDeviceIdToPeerId.delete(prev.jellyfinDeviceId);
        }
    }
    if (online && jellyfinDeviceId) {
        // Live binding: point the bridge at this peer.
        state.jfDeviceIdToPeerId.set(jellyfinDeviceId, peerId);
    } else if (!online && jellyfinDeviceId) {
        // B2: an explicit offline (LWT) releases LIVE routing ownership so a
        // departed peer can't durably hold a deviceId — which would otherwise
        // keep routing commands to a dead peer and make the mirror's gate
        // reject a legitimate new owner's frames. Only release if the entry
        // still points to us (a newer peer may already have claimed the dev).
        // The presence record below keeps the last-known dev for diagnostics.
        if (state.jfDeviceIdToPeerId.get(jellyfinDeviceId) === peerId) {
            state.jfDeviceIdToPeerId.delete(jellyfinDeviceId);
        }
    }
    state.presence.set(peerId, { jellyfinDeviceId, lastSeenAt: now, online });
    notifyIfChanged(peerId, now);
};

/**
 * Freshness-only refresh (SEV-1). A successful liveness probe (pong) proves the
 * peer is still alive, so bump its `lastSeenAt` WITHOUT touching `online` or the
 * `jellyfinDeviceId` reverse-map binding. This is deliberately NOT
 * `recordPresence(peer, true, now)` — that path deletes the reverse-map entry
 * whenever the supplied `dev` differs from the stored one (including the
 * `undefined` a pong carries), which would silently destroy the
 * jfDeviceId -> peerId bridge (SEV-4). A peer we've never seen a presence frame
 * for is ignored: a pong from an unknown peer can't conjure a presence record
 * out of thin air (online/dev would be unknowable).
 */
export const touchPresence = (peerId: string, now: number = Date.now()): void => {
    const rec = state.presence.get(peerId);
    if (!rec) return;
    rec.lastSeenAt = now;
    // Re-arm observers in case the peer had already aged out and a stale
    // 'jellyfin' was last reported — the refresh flips it back to 'mqtt'.
    notifyIfChanged(peerId, now);
};

/**
 * Forget a peer entirely — e.g. when the user clears the target or the
 * client disconnects. Drops the reverse-map entry too if it still points
 * to this peer.
 */
export const forgetPeer = (peerId: string): void => {
    const rec = state.presence.get(peerId);
    if (rec?.jellyfinDeviceId) {
        if (state.jfDeviceIdToPeerId.get(rec.jellyfinDeviceId) === peerId) {
            state.jfDeviceIdToPeerId.delete(rec.jellyfinDeviceId);
        }
    }
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
    state.jfDeviceIdToPeerId.clear();
    state.syncEnabled = false;
    lastChosen.clear();
    listeners.clear();
};
