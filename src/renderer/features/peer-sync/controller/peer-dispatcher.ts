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
import { publishCommand } from '/@/renderer/features/peer-sync/controller/peer-client';
import { pickTransport } from '/@/renderer/features/peer-sync/controller/transport-selector';
// `publishCommand` stays imported because `fireMqtt` below uses it; the
// callers above were inlined to a `route(... fireMqtt(...) ...)` pattern so
// outbound diagnostics always record.
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

/** Publish + record. Single seam so every MQTT outbound goes through one
 *  helper, which the diagnostics store taps for the recent-commands list. */
const fireMqtt = (peer: PeerAddress, cmd: PeerCommand): void => {
    publishCommand(peer, cmd);
    recordOutboundCommand(peer.peerId, cmd);
};

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
            () => fireMqtt(ctx.peer, buildCommand('seek', { positionMs })),
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
            () => fireMqtt(ctx.peer, buildCommand('volume', { volume })),
            () =>
                commandDispatcher.setVolume(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    volume,
                ),
        ),

    /**
     * Jump to a specific queue index. Maps to JF's `PlaylistIndex` playstate
     * command on the Jellyfin lane; the MQTT receiver applies it locally.
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
