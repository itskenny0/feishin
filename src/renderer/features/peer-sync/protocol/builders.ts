/**
 * Pure builders for the wire frames. Used by the dispatcher (to construct
 * commands) and by the state publisher (to construct retained snapshots).
 * Keeping these as plain functions makes them trivial to test and trivial
 * to call from either the renderer or any future cross-process bridge.
 */
import {
    PeerCommand,
    PeerCommandArgs,
    PeerCommandKind,
    PeerPresence,
    PeerRepeatMode,
    PeerState,
    PeerTrack,
    PROTOCOL_VERSION,
} from '/@/renderer/features/peer-sync/types';

export const buildCommand = (k: PeerCommandKind, a?: PeerCommandArgs): PeerCommand => ({
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
    /** Optional — the id of the track the target will actually play next
     *  (resolved against its shuffle map / repeat mode). Pass undefined to omit
     *  the field; pass null when there is explicitly no next track. */
    nxt?: null | string;
    /** Optional — the target's TRUE upcoming playback sequence (track ids in
     *  the order it will actually play them, shuffle + repeat aware). Pass
     *  undefined or [] to omit. Capped to MAX_PEER_NEXT_IDS on publish. */
    nxts?: string[];
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
/** Cap on the `nxts` upcoming-id list. The controller only renders a handful
 *  of "up next" rows before the user scrolls into the (default-order) tail, so
 *  a short cap keeps the frame small while still giving a truthful immediate
 *  sequence. Stays well under the codec's array sanity check. */
const MAX_PEER_NEXT_IDS = 64;
/** Wire range for `vol` — 0-100. Anything outside is clamped on publish so a
 *  buggy producer can't push a NaN / out-of-range volume through to peers. */
const MIN_VOL = 0;
const MAX_VOL = 100;
/** Wire range for `rate` — 0.5x-2x matches the engine's setSpeed contract. */
const MIN_RATE = 0.5;
const MAX_RATE = 2;

/** Coerce `n` into a finite number in `[lo, hi]`. Non-finite inputs collapse
 *  to `lo` so a NaN volume never leaves the publisher. */
const clampFinite = (n: number, lo: number, hi: number): number => {
    if (!Number.isFinite(n)) return lo;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
};

export const buildState = (input: StateSnapshotInput): PeerState => {
    // Defensive copy of the track — the caller (state-publisher / dispatcher)
    // typically constructs the input from store reads, but a future seam
    // could pass a live reference. A shallow clone keeps the wire frame
    // immutable from the caller's perspective without paying for a deep copy
    // of nullable string fields that can't reference anything.
    const trackCopy = input.track ? { ...input.track } : null;
    const out: PeerState = {
        // Both `dur` and `pos` are millisecond counters — negative makes no
        // physical sense and would confuse the controller's mirror (which
        // feeds positionMs straight into the playhead). Clamp at zero.
        dur: Number.isFinite(input.dur) ? Math.max(0, input.dur) : 0,
        paused: input.paused,
        pos: Number.isFinite(input.pos) ? Math.max(0, input.pos) : 0,
        rep: input.rep,
        shuf: input.shuf,
        t: 'state',
        track: trackCopy,
        ts: Date.now(),
        v: PROTOCOL_VERSION,
        vol: clampFinite(input.vol, MIN_VOL, MAX_VOL),
    };
    // Only emit optional fields when the caller supplied them. Keeps wire
    // frames small for v1 publishers and makes "absent" semantically distinct
    // from "default" on the receiver.
    if (typeof input.mut === 'boolean') out.mut = input.mut;
    if (typeof input.lyr === 'boolean') out.lyr = input.lyr;
    if (typeof input.rate === 'number' && Number.isFinite(input.rate)) {
        out.rate = clampFinite(input.rate, MIN_RATE, MAX_RATE);
    }
    // Next-track id: emit when the publisher supplied it (a non-empty string id
    // OR an explicit null meaning "no next track"). `undefined` omits the field
    // entirely so an older publisher that doesn't compute it can't be confused
    // with one that knows there's no next track. Empty strings are coerced to
    // null so a producer bug can't ship a meaningless "" id the consumer would
    // try to resolve.
    if (input.nxt !== undefined) {
        out.nxt = typeof input.nxt === 'string' && input.nxt.length > 0 ? input.nxt : null;
    }
    // Upcoming playback sequence (shuffle-correct). Filter non-string / empty
    // entries (a producer bug can't ship a "" the consumer would try to
    // resolve) and cap the length. Only emit when something survives — an
    // empty list is omitted entirely so "publisher doesn't carry it" and
    // "explicitly nothing upcoming" both decode as "absent" and the consumer
    // falls back to the default-order slice. `.slice()` copies so the caller
    // can't mutate the array post-publish.
    if (Array.isArray(input.nxts) && input.nxts.length > 0) {
        const filtered = input.nxts
            .slice(0, MAX_PEER_NEXT_IDS)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (filtered.length > 0) out.nxts = filtered;
    }
    if (Array.isArray(input.qIds) && input.qIds.length > 0) {
        // `.slice(0, N)` copies, so the caller can't mutate the array after
        // publish — same defensive-copy story as `trackCopy` above.
        const filtered = input.qIds
            .slice(0, MAX_PEER_QUEUE_IDS)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (filtered.length > 0) out.qIds = filtered;
    }
    // SEV-4: only emit `qIdx` alongside a `qIds` array it can index into. A bare
    // qIdx (qIds omitted/empty) is dead weight on the wire — the receiver's
    // mirror only consumes qIdx when qIds is present — and an easy footgun for a
    // publisher that truncates qIds to empty while still shipping qIdx. Gating
    // on `out.qIds !== undefined` keeps the invariant explicit.
    if (out.qIds !== undefined && typeof input.qIdx === 'number' && Number.isFinite(input.qIdx)) {
        // qIdx is an array index — negative is meaningful only as "no
        // selection" (-1). Allow that one sentinel through; clamp anything
        // worse to -1 so the receiver's branch on `qIdx >= 0` always wins.
        out.qIdx = input.qIdx < -1 ? -1 : Math.floor(input.qIdx);
    }
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
