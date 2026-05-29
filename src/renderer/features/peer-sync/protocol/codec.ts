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
const textDecoder = new TextDecoder();

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isValidCommand = (
    raw: Record<string, unknown>,
): raw is PeerCommand & Record<string, unknown> => {
    if (raw.t !== 'cmd') return false;
    if (typeof raw.k !== 'string') return false;
    if (typeof raw.ts !== 'number') return false;
    return true;
};

const isValidState = (raw: Record<string, unknown>): raw is PeerState & Record<string, unknown> => {
    if (raw.t !== 'state') return false;
    if (typeof raw.pos !== 'number') return false;
    if (typeof raw.dur !== 'number') return false;
    if (typeof raw.paused !== 'boolean') return false;
    if (typeof raw.vol !== 'number') return false;
    if (typeof raw.shuf !== 'boolean') return false;
    if (raw.rep !== 'off' && raw.rep !== 'all' && raw.rep !== 'one') return false;
    if (typeof raw.ts !== 'number') return false;
    if (raw.track !== null && !isObject(raw.track)) return false;
    // Optional v1+ fields — accept when absent, validate when present. A
    // wrong type for any of these drops the whole frame rather than risk
    // delivering garbage downstream.
    if (raw.mut !== undefined && typeof raw.mut !== 'boolean') return false;
    if (raw.lyr !== undefined && typeof raw.lyr !== 'boolean') return false;
    if (raw.rate !== undefined && typeof raw.rate !== 'number') return false;
    if (raw.qIdx !== undefined && typeof raw.qIdx !== 'number') return false;
    if (raw.qIds !== undefined) {
        if (!Array.isArray(raw.qIds)) return false;
        if (raw.qIds.some((id) => typeof id !== 'string')) return false;
    }
    return true;
};

const isValidPresence = (
    raw: Record<string, unknown>,
): raw is PeerPresence & Record<string, unknown> => {
    if (raw.t !== 'presence') return false;
    if (typeof raw.online !== 'boolean') return false;
    if (typeof raw.ts !== 'number') return false;
    return true;
};

const isValidPing = (raw: Record<string, unknown>): raw is PeerPing & Record<string, unknown> => {
    if (raw.t !== 'ping') return false;
    if (typeof raw.id !== 'string') return false;
    if (typeof raw.ts !== 'number') return false;
    return true;
};

const isValidPong = (raw: Record<string, unknown>): raw is PeerPong & Record<string, unknown> => {
    if (raw.t !== 'pong') return false;
    if (typeof raw.id !== 'string') return false;
    if (typeof raw.ts !== 'number') return false;
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
