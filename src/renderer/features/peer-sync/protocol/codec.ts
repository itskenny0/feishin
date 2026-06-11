/**
 * Wire-format codec.
 *
 * Pluggable — the public surface is a pair of pure functions that take and
 * return `Uint8Array`. The JSON implementation is the default; we keep a
 * single shared `codec` export so a future msgpack backend can replace it
 * without touching call sites. Tests exercise the JSON path directly.
 *
 * The codec is *strict*: an unknown `v` or a missing discriminator returns
 * null. Callers MUST drop nulls; they represent a frame we cannot trust.
 */
import {
    PeerCommand,
    PeerFrame,
    PeerPing,
    PeerPong,
    PeerPresence,
    PeerState,
    PROTOCOL_VERSION,
} from '/@/renderer/features/peer-sync/types';

export interface PeerCodec {
    /** Decode a payload received from the broker. Returns null on bad input. */
    decode(payload: Uint8Array): null | PeerFrame;
    /** Encode a frame to bytes for publish. */
    encode(frame: PeerFrame): Uint8Array;
}

const textEncoder = new TextEncoder();
// `fatal: true` makes the decoder throw on invalid UTF-8 instead of inserting
// replacement characters. We want to drop garbage payloads outright (the catch
// below returns null), not parse them as JSON-with-replacement-mojibake which
// could trick the validators into accepting a half-decoded frame.
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Maximum number of queue ids the decoder will accept in a state frame.
 *  Matches the publisher's MAX_PEER_QUEUE_IDS in builders.ts (200) plus a
 *  small forward-compat headroom so a slightly larger frame from a future
 *  publisher still decodes, but a malicious sender can't push us into a
 *  multi-megabyte allocation by quoting a million ids. */
const MAX_DECODE_QUEUE_IDS = 1_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when `v` is a number AND finite (rejects NaN, +Infinity, -Infinity).
 *  `typeof n === 'number'` alone passes NaN, which would smuggle through every
 *  numeric field on the wire — `Number.isFinite` is what we actually want. */
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A timestamp on the wire must be non-negative — `Date.now()` never returns
 *  negative, so a negative `ts` is either a buggy publisher or a tampered
 *  frame. Either way, drop. */
const isValidTimestamp = (v: unknown): v is number => isFiniteNumber(v) && v >= 0;

const isValidTrack = (raw: unknown): boolean => {
    if (raw === null) return true;
    if (!isObject(raw)) return false;
    // `id` is the only field downstream code derefs as a string (see
    // `peer-state-mirror.peerStateToMirrored` — it goes straight into
    // `Song.id`). Other string fields tolerate null on the wire.
    if (typeof raw.id !== 'string') return false;
    if (raw.title !== null && typeof raw.title !== 'string') return false;
    if (raw.album !== null && typeof raw.album !== 'string') return false;
    if (raw.artist !== null && typeof raw.artist !== 'string') return false;
    if (raw.art !== undefined && raw.art !== null && typeof raw.art !== 'string') return false;
    return true;
};

const isValidCommand = (
    raw: Record<string, unknown>,
): raw is PeerCommand & Record<string, unknown> => {
    if (raw.t !== 'cmd') return false;
    if (typeof raw.k !== 'string') return false;
    if (!isValidTimestamp(raw.ts)) return false;
    // `src` (sender peerId) is optional for backward-compat; when present it
    // must be a string so the receiver can trust it as the command's origin.
    if (raw.src !== undefined && typeof raw.src !== 'string') return false;
    return true;
};

const isValidState = (raw: Record<string, unknown>): raw is PeerState & Record<string, unknown> => {
    if (raw.t !== 'state') return false;
    // Required numerics must be finite. `Number.isFinite` rejects NaN /
    // Infinity which `typeof n === 'number'` otherwise lets pass.
    if (!isFiniteNumber(raw.pos)) return false;
    if (!isFiniteNumber(raw.dur)) return false;
    if (!isFiniteNumber(raw.vol)) return false;
    if (typeof raw.paused !== 'boolean') return false;
    if (typeof raw.shuf !== 'boolean') return false;
    if (raw.rep !== 'off' && raw.rep !== 'all' && raw.rep !== 'one') return false;
    if (!isValidTimestamp(raw.ts)) return false;
    if (!isValidTrack(raw.track)) return false;
    // Optional v1+ fields — accept when absent, validate when present. A
    // wrong type for any of these drops the whole frame rather than risk
    // delivering garbage downstream.
    if (raw.mut !== undefined && typeof raw.mut !== 'boolean') return false;
    if (raw.lyr !== undefined && typeof raw.lyr !== 'boolean') return false;
    if (raw.rate !== undefined && !isFiniteNumber(raw.rate)) return false;
    if (raw.qIdx !== undefined && !isFiniteNumber(raw.qIdx)) return false;
    // `nxt` (next-track id) is a nullable string: absent = publisher doesn't
    // carry it, null = explicitly no next track, string = the next track id.
    // Any other type drops the frame so a garbage `nxt` can't poison the
    // controller's next-track resolution.
    if (raw.nxt !== undefined && raw.nxt !== null && typeof raw.nxt !== 'string') return false;
    // `nxts` (true upcoming-id sequence) is an optional string[]. Absent =
    // publisher doesn't carry it; present must be an array of strings within
    // the same length cap as qIds so a hostile sender can't force a huge
    // allocation. A non-array or a non-string entry drops the whole frame so a
    // garbage `nxts` can't poison the controller's queue-order resolution.
    if (raw.nxts !== undefined) {
        if (!Array.isArray(raw.nxts)) return false;
        if (raw.nxts.length > MAX_DECODE_QUEUE_IDS) return false;
        if (raw.nxts.some((id) => typeof id !== 'string')) return false;
    }
    if (raw.qIds !== undefined) {
        if (!Array.isArray(raw.qIds)) return false;
        // Cap array length up front so a million-element qIds array doesn't
        // force us to iterate every entry just to reject it.
        if (raw.qIds.length > MAX_DECODE_QUEUE_IDS) return false;
        if (raw.qIds.some((id) => typeof id !== 'string')) return false;
    }
    return true;
};

const isValidPresence = (
    raw: Record<string, unknown>,
): raw is PeerPresence & Record<string, unknown> => {
    if (raw.t !== 'presence') return false;
    if (typeof raw.online !== 'boolean') return false;
    if (!isValidTimestamp(raw.ts)) return false;
    // `dev` is documented as the publisher's Jellyfin Sessions deviceId; only
    // accept it when it's a string. A non-string `dev` would still let the
    // frame through to the transport-selector's reverse map, which expects
    // strings — drop the whole frame instead so the map can't be poisoned.
    if (raw.dev !== undefined && typeof raw.dev !== 'string') return false;
    return true;
};

const isValidPing = (raw: Record<string, unknown>): raw is PeerPing & Record<string, unknown> => {
    if (raw.t !== 'ping') return false;
    if (typeof raw.id !== 'string') return false;
    if (!isValidTimestamp(raw.ts)) return false;
    return true;
};

const isValidPong = (raw: Record<string, unknown>): raw is PeerPong & Record<string, unknown> => {
    if (raw.t !== 'pong') return false;
    if (typeof raw.id !== 'string') return false;
    if (!isValidTimestamp(raw.ts)) return false;
    return true;
};

const jsonCodec: PeerCodec = {
    decode: (payload) => {
        try {
            const text = textDecoder.decode(payload);
            const parsed: unknown = JSON.parse(text);
            if (!isObject(parsed)) return null;
            // Version gate — drop everything from a future or unknown major.
            if (parsed.v !== PROTOCOL_VERSION) return null;
            if (isValidCommand(parsed)) return parsed;
            if (isValidState(parsed)) return parsed;
            if (isValidPresence(parsed)) return parsed;
            if (isValidPing(parsed)) return parsed;
            if (isValidPong(parsed)) return parsed;
            return null;
        } catch {
            return null;
        }
    },
    encode: (frame) => textEncoder.encode(JSON.stringify(frame)),
};

/**
 * The active codec instance. Swap this re-export for msgpack/etc later by
 * pointing it at a different `PeerCodec`. All higher-level code consumes
 * this binding, never the json one directly.
 */
export const codec: PeerCodec = jsonCodec;

/** Exposed for tests / future codec backends. */
export { jsonCodec };
