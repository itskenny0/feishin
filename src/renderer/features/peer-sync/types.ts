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
    a?: PeerCommandArgs;
    /** Command verb. */
    k: PeerCommandKind;
    /**
     * Sender peerId. Commands are addressed to the TARGET's topic (so only the
     * intended recipient acts on them), so the topic identifies the target, not
     * the source. `src` carries the real sender so the receiver's authorisation
     * gate can identify who sent the command instead of mistaking its own topic
     * for a self-frame. Optional for backward-compat with producers that predate
     * the field (those fall back to the topic peerId).
     */
    src?: string;
    /** Frame type discriminator. */
    t: 'cmd';
    /** Publisher timestamp (epoch ms). Receivers MAY ignore drift > 5s. */
    ts: number;
    /** Wire-format version. */
    v: typeof PROTOCOL_VERSION;
}

/**
 * Per-verb args payload. The wire allows any of these shapes; the receiver
 * narrows by `k` before reading specific properties. We deliberately don't
 * make `PeerCommand` itself a discriminated union of `(k, a)` pairs — the
 * codec validates only `k`'s presence, and a producer that ships an unknown
 * verb is supposed to round-trip cleanly so that older receivers can simply
 * drop the frame at the verb-switch instead of the codec.
 */
export type PeerCommandArgs =
    | undefined
    | { from: number; to: number } // queueReorder
    | { index: number; itemIds: string[] } // queueInsert
    | { index: number } // playIndex — DEFAULT-order queue index (SEV-3); the
    // receiver's mediaPlayByIndex maps it to the shuffled playback position
    // internally, so a controller MUST send a default-order index (convert a
    // visible/shuffled tap with mapShuffledToQueueIndex's inverse first).
    | { indices: number[] } // queueRemove
    | { itemIds: string[]; playCommand?: 'PlayLast' | 'PlayNext' | 'PlayNow'; startIndex?: number } // play
    | { mode: PeerRepeatMode } // repeat
    | { mute: boolean } // mute
    | { positionMs: number } // seek
    | { rate: number } // rate
    | { shuffle: boolean } // shuffle
    | { visible: boolean } // lyrics
    | { volume: number }; // volume

/**
 * Command verbs that flow controller → target. Mirrors the existing Jellyfin
 * command set 1:1 so the transport selector can swap lanes transparently.
 *
 * `mute` and `playIndex` were added in v1 as optional verbs — receivers that
 * don't recognise a verb MUST drop the frame silently (codec passes the
 * unknown verb through and the dispatcher seam routes it; only the receiver
 * decides whether to act). The legacy verbs (`next`, `pause`, …) still
 * decode unchanged.
 *
 * `queueInsert`, `queueRemove`, `queueReorder`, `rate`, and `lyrics` are
 * MQTT-only verbs added on top of the original Jellyfin parity surface —
 * Jellyfin's remote-control API has no equivalent for any of them. The
 * dispatcher's `route()` helper still picks a lane per-verb, and the
 * jellyfin lane for these verbs is a documented no-op with a `[peer-sync]
 * dropped … on jellyfin lane` warn so the producer can see the verb didn't
 * land. Receivers that don't know one of these verbs still drop silently
 * via the codec → switch-default path.
 */
export type PeerCommandKind =
    | 'lyrics'
    | 'mute'
    | 'next'
    | 'pause'
    | 'play'
    | 'playIndex'
    | 'prev'
    | 'queue'
    | 'queueInsert'
    | 'queueRemove'
    | 'queueReorder'
    | 'rate'
    | 'repeat'
    | 'seek'
    | 'shuffle'
    | 'stop'
    | 'togglePause'
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
    /** Publisher's Jellyfin Sessions deviceId, when known. Lets remote picker
     *  UIs bridge a Jellyfin device row to its MQTT peer so the command lane
     *  can upgrade to MQTT for that target. Optional for backward compat —
     *  older publishers omit it and stay on the Jellyfin lane. */
    dev?: string;
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

/**
 * Retained target → controller state snapshot. Late joiners get the latest.
 *
 * Optional fields (`mut`, `qIds`, `qIdx`, `lyr`, `rate`, `nxt`) were added
 * after the initial v1 cut. Older readers ignore unknown keys and the codec
 * validates each optional field's type independently, so a frame produced by a
 * newer publisher decodes cleanly on an older consumer (just without the
 * extras).
 *
 * Required fields stay required — bumping any of those is a v2 change.
 */
export interface PeerState {
    /** Track duration in milliseconds. */
    dur: number;
    /** Lyrics visibility on the target (Feishin↔Feishin only — undefined when
     *  the target doesn't have a lyrics pane concept). */
    lyr?: boolean;
    /** True when the target is muted (independent of volume). Optional —
     *  consumers older than this field treat `undefined` as "not muted". */
    mut?: boolean;
    /**
     * The track id the target will ACTUALLY play next, resolved on the target
     * by its own shuffle map + repeat mode. Optional — emitted by Feishin
     * targets so a controller can render the correct "up next" / peek cover
     * even when the target has shuffle ON (where `qIds[qIdx + 1]` in DEFAULT
     * order is the wrong song). `null`/absent when there is no next track
     * (end of queue, repeat off). Consumers fall back to the default-order
     * `qIds[qIdx + 1]` derivation when this is absent. */
    nxt?: null | string;
    /** True when the target is paused. */
    paused: boolean;
    /** Current position in milliseconds. */
    pos: number;
    /** Truncated queue id list, in DEFAULT (non-shuffle) order. Optional — the
     *  controller hydrates this into Song objects through the existing
     *  `hydrateSongs` path so the queue panel mirrors the target. Capped at 200
     *  items to match the Jellyfin-lane truncation.
     *
     *  Index-space contract (SEV-3): `qIds` is the publisher's
     *  `getQueueOrder().items` (default order), which is the SAME order the
     *  receiver's `mediaPlayByIndex` / queue verbs interpret an index against.
     *  This holds EVEN WHEN the target has shuffle on — emitting the visible
     *  shuffled order here would make a controller's tap jump to the wrong track
     *  on the receiver. */
    qIds?: string[];
    /** Index of the currently-playing item in `qIds`, in DEFAULT order. -1 /
     *  absent when not resolvable. The publisher resolves the now-playing item's
     *  position by `_uniqueId` against the default-order queue, so shuffle on the
     *  target still produces a default-order index the controller can act on. */
    qIdx?: number;
    /** Playback rate (1.0 = normal). Surface-only — emitted by Feishin
     *  targets so a controller can display the target's speed; control of
     *  this is a local engine setting and is not round-tripped. */
    rate?: number;
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
