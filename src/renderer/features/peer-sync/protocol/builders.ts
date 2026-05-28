/**
 * Pure builders for the wire frames. Used by the dispatcher (to construct
 * commands) and by the state publisher (to construct retained snapshots).
 * Keeping these as plain functions makes them trivial to test and trivial
 * to call from either the renderer or any future cross-process bridge.
 */
import {
    PeerCommand,
    PeerCommandKind,
    PeerPresence,
    PeerRepeatMode,
    PeerState,
    PeerTrack,
    PROTOCOL_VERSION,
} from '/@/renderer/features/peer-sync/types';

export const buildCommand = (k: PeerCommandKind, a?: unknown): PeerCommand => ({
    a,
    k,
    t: 'cmd',
    ts: Date.now(),
    v: PROTOCOL_VERSION,
});

export interface StateSnapshotInput {
    dur: number;
    /** Optional — lyrics visible on the target. Pass undefined to omit from
     *  the wire frame entirely so consumers can distinguish "unknown" from
     *  "false". */
    lyr?: boolean;
    /** Optional — target mute state. Pass undefined to omit. */
    mut?: boolean;
    paused: boolean;
    pos: number;
    /** Optional — queue id list. Pass undefined or [] to omit. */
    qIds?: string[];
    /** Optional — index of the now-playing item in qIds. */
    qIdx?: number;
    /** Optional — playback rate (1.0 = normal). */
    rate?: number;
    rep: PeerRepeatMode;
    shuf: boolean;
    track: null | PeerTrack;
    vol: number;
}

const MAX_PEER_QUEUE_IDS = 200;

export const buildState = (input: StateSnapshotInput): PeerState => {
    const out: PeerState = {
        dur: input.dur,
        paused: input.paused,
        pos: input.pos,
        rep: input.rep,
        shuf: input.shuf,
        t: 'state',
        track: input.track,
        ts: Date.now(),
        v: PROTOCOL_VERSION,
        vol: input.vol,
    };
    // Only emit optional fields when the caller supplied them. Keeps wire
    // frames small for v1 publishers and makes "absent" semantically distinct
    // from "default" on the receiver.
    if (typeof input.mut === 'boolean') out.mut = input.mut;
    if (typeof input.lyr === 'boolean') out.lyr = input.lyr;
    if (typeof input.rate === 'number' && Number.isFinite(input.rate)) out.rate = input.rate;
    if (Array.isArray(input.qIds) && input.qIds.length > 0) {
        out.qIds = input.qIds.slice(0, MAX_PEER_QUEUE_IDS);
    }
    if (typeof input.qIdx === 'number' && Number.isFinite(input.qIdx)) out.qIdx = input.qIdx;
    return out;
};

export const buildPresence = (online: boolean): PeerPresence => ({
    online,
    t: 'presence',
    ts: Date.now(),
    v: PROTOCOL_VERSION,
});

/**
 * Map a Jellyfin-style repeat string (`RepeatNone` / `RepeatAll` / `RepeatOne`)
 * to the compact peer enum. Falls back to `'off'` for anything unrecognized
 * so a misbehaving session can't crash the codec.
 */
export const jellyfinToPeerRepeat = (mode: string | undefined): PeerRepeatMode => {
    if (mode === 'RepeatAll') return 'all';
    if (mode === 'RepeatOne') return 'one';
    return 'off';
};

/** Inverse — needed when an MQTT command lands and we forward to Jellyfin. */
export const peerToJellyfinRepeat = (mode: PeerRepeatMode): string => {
    if (mode === 'all') return 'RepeatAll';
    if (mode === 'one') return 'RepeatOne';
    return 'RepeatNone';
};
