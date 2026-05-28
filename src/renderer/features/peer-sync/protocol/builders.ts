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
    paused: boolean;
    pos: number;
    rep: PeerRepeatMode;
    shuf: boolean;
    track: null | PeerTrack;
    vol: number;
}

export const buildState = (input: StateSnapshotInput): PeerState => ({
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
});

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
