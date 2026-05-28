/**
 * Wire-format and runtime types for the MQTT peer-sync transport.
 *
 * The values here are tagged with `v:1` so future revisions of the protocol
 * can be additive: receivers of an unknown version drop the message rather
 * than mis-parsing it. The codec layer is the single place that asserts the
 * version on the way in.
 */

/** Supported wire-format protocol version. Bump on any breaking change. */
export const PROTOCOL_VERSION = 1 as const;

/** Controller → target command frame. */
export interface PeerCommand {
    /** Optional payload — shape depends on `k`. e.g. seek carries `{ positionMs }`. */
    a?: unknown;
    /** Command verb. */
    k: PeerCommandKind;
    /** Frame type discriminator. */
    t: 'cmd';
    /** Publisher timestamp (epoch ms). Receivers MAY ignore drift > 5s. */
    ts: number;
    /** Wire-format version. */
    v: typeof PROTOCOL_VERSION;
}

/**
 * Command verbs that flow controller → target. Mirrors the existing Jellyfin
 * command set 1:1 so the transport selector can swap lanes transparently.
 */
export type PeerCommandKind =
    | 'next'
    | 'pause'
    | 'play'
    | 'prev'
    | 'queue'
    | 'repeat'
    | 'seek'
    | 'shuffle'
    | 'volume';

export type PeerFrame = PeerCommand | PeerPing | PeerPong | PeerPresence | PeerState;

/**
 * Liveness probe: the sender publishes a Ping, the addressed peer mirrors
 * the `id` back in a Pong. Senders compute round-trip ms by subtracting the
 * Ping's `ts` from the Pong's arrival time. Either side may originate.
 */
export interface PeerPing {
    /** Opaque probe id. Receivers echo it verbatim. */
    id: string;
    /** Frame type discriminator. */
    t: 'ping';
    /** Publisher timestamp (epoch ms). */
    ts: number;
    /** Wire-format version. */
    v: typeof PROTOCOL_VERSION;
}

/** Pong response to a Ping. `id` echoes the Ping's `id`. */
export interface PeerPong {
    id: string;
    /** Frame type discriminator. */
    t: 'pong';
    /** Publisher timestamp (epoch ms). */
    ts: number;
    /** Wire-format version. */
    v: typeof PROTOCOL_VERSION;
}

/** Retained presence frame. LWT publishes `{ online: false }` on disconnect. */
export interface PeerPresence {
    online: boolean;
    /** Frame type discriminator. */
    t: 'presence';
    /** Publisher timestamp (epoch ms). */
    ts: number;
    /** Wire-format version. */
    v: typeof PROTOCOL_VERSION;
}

/** Repeat-mode wire enum. Distinct from Jellyfin's strings — codec maps both ways. */
export type PeerRepeatMode = 'all' | 'off' | 'one';

/** Retained target → controller state snapshot. Late joiners get the latest. */
export interface PeerState {
    /** Track duration in milliseconds. */
    dur: number;
    /** True when the target is paused. */
    paused: boolean;
    /** Current position in milliseconds. */
    pos: number;
    /** Repeat mode. */
    rep: PeerRepeatMode;
    /** Shuffle on/off. */
    shuf: boolean;
    /** Frame type discriminator. */
    t: 'state';
    /** Now-playing track, or null when nothing is loaded. */
    track: null | PeerTrack;
    /** Publisher timestamp (epoch ms). Used for staleness checks. */
    ts: number;
    /** Wire-format version. */
    v: typeof PROTOCOL_VERSION;
    /** Volume, 0-100. */
    vol: number;
}

/** Compact track snapshot embedded in state frames. Optional cover-art URL. */
export interface PeerTrack {
    album: null | string;
    art?: null | string;
    artist: null | string;
    id: string;
    title: null | string;
}

/**
 * A transport is the runtime abstraction the dispatcher publishes through.
 * The transport-selector decides which one (MQTT or Jellyfin) is alive for a
 * given peer right now.
 */
export type TransportKind = 'jellyfin' | 'mqtt';
