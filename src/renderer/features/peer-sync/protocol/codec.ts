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

const isValidCommand = (raw: Record<string, unknown>): boolean => {
    if (raw.t !== 'cmd') return false;
    if (typeof raw.k !== 'string') return false;
    if (typeof raw.ts !== 'number') return false;
    return true;
};

const isValidState = (raw: Record<string, unknown>): boolean => {
    if (raw.t !== 'state') return false;
    if (typeof raw.pos !== 'number') return false;
    if (typeof raw.dur !== 'number') return false;
    if (typeof raw.paused !== 'boolean') return false;
    if (typeof raw.vol !== 'number') return false;
    if (typeof raw.shuf !== 'boolean') return false;
    if (raw.rep !== 'off' && raw.rep !== 'all' && raw.rep !== 'one') return false;
    if (typeof raw.ts !== 'number') return false;
    if (raw.track !== null && !isObject(raw.track)) return false;
    return true;
};

const isValidPresence = (raw: Record<string, unknown>): boolean => {
    if (raw.t !== 'presence') return false;
    if (typeof raw.online !== 'boolean') return false;
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
            if (isValidCommand(parsed)) return parsed as unknown as PeerCommand;
            if (isValidState(parsed)) return parsed as unknown as PeerState;
            if (isValidPresence(parsed)) return parsed as unknown as PeerPresence;
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
