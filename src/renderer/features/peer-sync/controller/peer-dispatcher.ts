/**
 * Transport-aware dispatcher seam.
 *
 * Lives *next to* the existing `command-dispatcher.ts` rather than rewriting
 * it. Call sites that want peer-sync aware behavior call this module; the
 * indirection picks a lane via the transport selector and either:
 *
 *   - publishes a compact PeerCommand over MQTT (when the selected lane is
 *     MQTT), letting the target Feishin's message handler apply it locally,
 *     OR
 *   - delegates to the original Jellyfin commandDispatcher (when the lane
 *     is Jellyfin), preserving today's behavior bit-for-bit.
 *
 * The existing dispatcher's hot path is unchanged — call sites that haven't
 * been migrated to the seam continue to publish straight to Jellyfin.
 */
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { commandDispatcher } from '/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher';
import { pickTransport } from '/@/renderer/features/peer-sync/controller/transport-selector';
import { recordOutboundCommand } from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import {
    buildCommand,
    peerToJellyfinRepeat,
} from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerAddress } from '/@/renderer/features/peer-sync/protocol/topics';
import { PeerCommand, PeerRepeatMode } from '/@/renderer/features/peer-sync/types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);
const warn = (...args: unknown[]) => console.warn('[peer-sync]', ...args);

/**
 * Helper for MQTT-only verbs. Jellyfin's remote-control surface has no
 * equivalent for queue mutations (insert / remove / reorder), playback
 * rate, or lyrics-pane visibility, so the dispatcher's `jfFire` for those
 * verbs is a documented no-op + warn. We keep the verb on the dispatcher
 * because the transport selector still decides which lane the call lands
 * on per peer, and a controller paired with a Jellyfin-only target should
 * see a log line when its action quietly evaporates rather than fail
 * silently with no diagnostics. The dispatcher itself doesn't refuse to
 * register the call — that's an explicit product decision so the UI can
 * still surface the control regardless of the chosen lane.
 */
const jfNoop = (verb: string): (() => void) => {
    return () => {
        warn(`dropped ${verb} on jellyfin lane`);
    };
};

// `publishCommand` lives in peer-client.ts, which statically pulls in the
// ~360 KB `mqtt` graph. We import it lazily so the dispatcher — reachable from
// the renderer ENTRY via player-context — does NOT drag mqtt into the entry
// chunk. `fireMqtt` only ever runs when `route()` selects the MQTT lane, which
// only happens when a peer is live; by then `use-peer-sync` has already mounted
// and loaded peer-client, so this dynamic import resolves from the warm
// `vendor-mqtt` chunk near-instantly.
type PublishCommandFn =
    (typeof import('/@/renderer/features/peer-sync/controller/peer-client'))['publishCommand'];

let publishCommandFn: null | PublishCommandFn = null;
let publishCommandLoading: null | Promise<PublishCommandFn> = null;

const loadPublishCommand = (): Promise<PublishCommandFn> => {
    if (publishCommandFn) return Promise.resolve(publishCommandFn);
    if (publishCommandLoading) return publishCommandLoading;
    publishCommandLoading = import('/@/renderer/features/peer-sync/controller/peer-client')
        .then((mod) => {
            publishCommandFn = mod.publishCommand;
            return publishCommandFn;
        })
        .catch((err) => {
            // A failed chunk fetch (offline, cache eviction mid-session) must
            // not strand the dispatcher in a rejected-promise state — reset so
            // a later command retries the load. The command that triggered this
            // load is dropped; MQTT publishes are QoS-0 fire-and-forget and the
            // next state echo is the source of truth, so a dropped frame is
            // self-healing.
            warn('failed to load mqtt publish seam', { err: (err as Error).message });
            publishCommandLoading = null;
            throw err;
        });
    return publishCommandLoading;
};

/**
 * Eagerly resolve the lazily-loaded `publishCommand` so the MQTT-lane publish
 * path runs synchronously. Called when the peer-sync subsystem boots (see
 * `use-peer-sync.tsx`) so a live peer's commands never hit the cold-start
 * microtask. Returns the resolved fn so tests can await it before asserting on
 * synchronous publishes.
 */
export const warmMqttPublish = (): Promise<PublishCommandFn> => loadPublishCommand();

/** Publish + record. Single seam so every MQTT outbound goes through one
 *  helper, which the diagnostics store taps for the recent-commands list.
 *
 *  Diagnostics are recorded synchronously (the recent-commands list reflects
 *  intent regardless of wire timing). The publish itself goes out as soon as
 *  the lazily-loaded `publishCommand` resolves — synchronously when it is
 *  already cached (the normal live-peer case), or on the next microtask during
 *  the rare cold-start window. `publishCommand` is QoS-0 fire-and-forget, so a
 *  microtask of slack never changes observable behaviour. */
const fireMqtt = (peer: PeerAddress, cmd: PeerCommand): void => {
    recordOutboundCommand(peer.peerId, cmd);
    if (publishCommandFn) {
        publishCommandFn(peer, cmd);
        return;
    }
    // Swallow load failures here — loadPublishCommand already logs + resets so
    // a later command retries. Dropping this QoS-0 frame is self-healing.
    void loadPublishCommand()
        .then((publish) => publish(peer, cmd))
        .catch(() => {});
};

/**
 * J5: coalesce a high-frequency drag (seek / volume) on the MQTT lane the same
 * way the Jellyfin lane already does in command-dispatcher. A 60-event slider
 * drag would otherwise emit 60 QoS-0 publishes per second to the peer — the
 * exact "wake up and burst" symptom the Jellyfin-lane coalesce exists to
 * prevent, just on the other lane.
 *
 * Leading + trailing, keyed per (peerId, verb) so a volume drag and a seek
 * drag don't share a slot and device-A's drag never blocks device-B. The
 * leading call fires immediately for instant feedback; while the throttle
 * window is open the latest args replace the pending slot and fire once when it
 * closes. QoS-0 fire-and-forget means there's no in-flight ack to await, so we
 * throttle on a timer rather than on completion.
 */
const MQTT_COALESCE_MS = 60;

interface CoalesceSlot {
    lastFiredAt: number;
    pending: (() => void) | null;
    timer: null | ReturnType<typeof setTimeout>;
}

const coalesceSlots = new Map<string, CoalesceSlot>();

const coalesceMqtt = (key: string, fire: () => void): void => {
    let slot = coalesceSlots.get(key);
    if (!slot) {
        slot = { lastFiredAt: 0, pending: null, timer: null };
        coalesceSlots.set(key, slot);
    }
    const now = Date.now();
    const elapsed = now - slot.lastFiredAt;
    if (elapsed >= MQTT_COALESCE_MS && !slot.timer) {
        // Leading edge — fire immediately.
        slot.lastFiredAt = now;
        fire();
        return;
    }
    // Inside the window: stash the latest and arm a trailing publish.
    slot.pending = fire;
    if (slot.timer) return;
    slot.timer = setTimeout(
        () => {
            const s = coalesceSlots.get(key);
            if (!s) return;
            s.timer = null;
            const next = s.pending;
            s.pending = null;
            if (next) {
                s.lastFiredAt = Date.now();
                next();
            }
        },
        Math.max(0, MQTT_COALESCE_MS - elapsed),
    );
};

/**
 * Clear every coalesce slot and its pending trailing timer. Call on peer-sync
 * teardown so a queued trailing publish can't fire against a torn-down (or, on a
 * fast stop→start, a fresh) session, and the per-peerId slot map doesn't retain
 * entries for every device ever controlled this session.
 */
export const clearMqttCoalesce = (): void => {
    for (const slot of coalesceSlots.values()) {
        if (slot.timer) clearTimeout(slot.timer);
    }
    coalesceSlots.clear();
};

/** Test-only alias for {@link clearMqttCoalesce}. */
export const __resetMqttCoalesce = clearMqttCoalesce;

export interface PeerDispatcherCtx {
    /** Address of the remote peer. Required when the MQTT lane is alive. */
    peer: PeerAddress;
    server: ServerListItemWithCredential;
    sessionId: string;
}

/**
 * Decide and act. When `peer.peerId` is empty the call always goes to
 * Jellyfin — the seam degrades to the original dispatcher.
 */
const route = (ctx: PeerDispatcherCtx, mqttFire: () => void, jfFire: () => void): void => {
    const lane = ctx.peer.peerId ? pickTransport(ctx.peer.peerId) : 'jellyfin';
    if (lane === 'mqtt') {
        log('dispatch via mqtt', { peerId: ctx.peer.peerId });
        mqttFire();
        return;
    }
    jfFire();
};

export const peerDispatcher = {
    next: (ctx: PeerDispatcherCtx): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('next')),
            () => void commandDispatcher.next({ server: ctx.server, sessionId: ctx.sessionId }),
        ),

    pause: (ctx: PeerDispatcherCtx): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('pause')),
            () => void commandDispatcher.pause({ server: ctx.server, sessionId: ctx.sessionId }),
        ),

    play: (
        ctx: PeerDispatcherCtx,
        args?: {
            itemIds: string[];
            playCommand?: 'PlayLast' | 'PlayNext' | 'PlayNow';
            startIndex?: number;
        },
    ): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('play', args)),
            () => {
                // No args = "resume current playback" — Jellyfin needs the
                // explicit Unpause verb. The MQTT lane carries it inside
                // the bare-`play` shape (receiver's `case 'play'` handles
                // both: itemIds present = queue-replace, absent = resume).
                if (!args) {
                    void commandDispatcher.unpause({
                        server: ctx.server,
                        sessionId: ctx.sessionId,
                    });
                    return;
                }
                void commandDispatcher.play({ server: ctx.server, sessionId: ctx.sessionId }, args);
            },
        ),

    previous: (ctx: PeerDispatcherCtx): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('prev')),
            () =>
                void commandDispatcher.previous({
                    server: ctx.server,
                    sessionId: ctx.sessionId,
                }),
        ),

    /**
     * Insert tracks into the target's queue at the given index. MQTT-only —
     * Jellyfin's `Playing` command replaces the entire queue (PlayNow /
     * PlayNext / PlayLast), there's no "insert at index N" verb.
     */
    queueInsert: (ctx: PeerDispatcherCtx, args: { index: number; itemIds: string[] }): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('queueInsert', args)),
            jfNoop('queueInsert'),
        ),

    /**
     * Remove queue items at the given indices on the target. MQTT-only —
     * Jellyfin has no granular queue removal verb.
     */
    queueRemove: (ctx: PeerDispatcherCtx, indices: number[]): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('queueRemove', { indices })),
            jfNoop('queueRemove'),
        ),

    /**
     * Drag-reorder a single queue item on the target. MQTT-only — same
     * rationale as queueInsert / queueRemove.
     */
    queueReorder: (ctx: PeerDispatcherCtx, args: { from: number; to: number }): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('queueReorder', args)),
            jfNoop('queueReorder'),
        ),

    seek: (ctx: PeerDispatcherCtx, positionMs: number): void =>
        route(
            ctx,
            // J5: coalesce the MQTT publish so a slider drag collapses to
            // leading + trailing instead of flooding the peer with QoS-0 frames.
            () =>
                coalesceMqtt(`${ctx.peer.peerId}:seek`, () =>
                    fireMqtt(ctx.peer, buildCommand('seek', { positionMs })),
                ),
            () =>
                commandDispatcher.seek(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    positionMs,
                ),
        ),

    /**
     * Toggle the target's lyrics pane. MQTT-only — Jellyfin's remote control
     * surface has no concept of a per-target lyrics view.
     */
    setLyricsVisible: (ctx: PeerDispatcherCtx, visible: boolean): void =>
        route(ctx, () => fireMqtt(ctx.peer, buildCommand('lyrics', { visible })), jfNoop('lyrics')),

    setMute: (ctx: PeerDispatcherCtx, mute: boolean): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('mute', { mute })),
            () =>
                void commandDispatcher.setMute(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    mute,
                ),
        ),

    /**
     * Set the target's playback rate. 1.0 = normal; the wire range is
     * 0.5..2.0. MQTT-only — Jellyfin has no equivalent control verb.
     */
    setRate: (ctx: PeerDispatcherCtx, rate: number): void =>
        route(ctx, () => fireMqtt(ctx.peer, buildCommand('rate', { rate })), jfNoop('rate')),

    setRepeat: (ctx: PeerDispatcherCtx, mode: PeerRepeatMode): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('repeat', { mode })),
            () =>
                void commandDispatcher.setRepeat(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    peerToJellyfinRepeat(mode),
                ),
        ),

    setShuffle: (ctx: PeerDispatcherCtx, shuffle: boolean): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('shuffle', { shuffle })),
            () =>
                void commandDispatcher.setShuffle(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    shuffle,
                ),
        ),

    setVolume: (ctx: PeerDispatcherCtx, volume: number): void =>
        route(
            ctx,
            // J5: coalesce the MQTT publish (see seek).
            () =>
                coalesceMqtt(`${ctx.peer.peerId}:volume`, () =>
                    fireMqtt(ctx.peer, buildCommand('volume', { volume })),
                ),
            () =>
                commandDispatcher.setVolume(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    volume,
                ),
        ),

    /**
     * Jump to a specific (default-order) queue index. On the MQTT lane the
     * receiver applies a `playIndex` verb locally; on the Jellyfin lane the
     * command-dispatcher re-issues the mirrored queue with PlayNow + StartIndex
     * (H1 — Jellyfin has no native "jump to index" Playstate verb).
     */
    skipToIndex: (ctx: PeerDispatcherCtx, index: number): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('playIndex', { index })),
            () =>
                void commandDispatcher.skipToIndex(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    index,
                ),
        ),

    /** Stop playback and clear the queue on the target. */
    stop: (ctx: PeerDispatcherCtx): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('stop')),
            () => void commandDispatcher.stop({ server: ctx.server, sessionId: ctx.sessionId }),
        ),

    /**
     * Toggle play/pause on the target. MQTT carries this as its own verb so
     * the receiver doesn't have to consult the controller's mirrored state
     * (which could race with the user's tap when the lane has been flipped
     * mid-command).
     */
    togglePause: (ctx: PeerDispatcherCtx): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('togglePause')),
            () =>
                void commandDispatcher.togglePause({
                    server: ctx.server,
                    sessionId: ctx.sessionId,
                }),
        ),

    /**
     * Resume current playback on the target. MQTT shares the wire shape with
     * `play` (no itemIds), so the receiver's `case 'play'` handles both.
     */
    unpause: (ctx: PeerDispatcherCtx): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('play')),
            () => void commandDispatcher.unpause({ server: ctx.server, sessionId: ctx.sessionId }),
        ),
};
