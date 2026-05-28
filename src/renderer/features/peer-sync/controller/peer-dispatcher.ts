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
import { recordOutboundCommand } from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import {
    buildCommand,
    peerToJellyfinRepeat,
} from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerAddress } from '/@/renderer/features/peer-sync/protocol/topics';
import { PeerCommand, PeerRepeatMode } from '/@/renderer/features/peer-sync/types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

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
        args: {
            itemIds: string[];
            playCommand?: 'PlayLast' | 'PlayNext' | 'PlayNow';
            startIndex?: number;
        },
    ): void =>
        route(
            ctx,
            () => fireMqtt(ctx.peer, buildCommand('play', args)),
            () =>
                void commandDispatcher.play({ server: ctx.server, sessionId: ctx.sessionId }, args),
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

    setMute: (ctx: PeerDispatcherCtx, mute: boolean): void =>
        route(
            ctx,
            () => publishCommand(ctx.peer, buildCommand('mute', { mute })),
            () =>
                void commandDispatcher.setMute(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    mute,
                ),
        ),

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
            () => publishCommand(ctx.peer, buildCommand('playIndex', { index })),
            () =>
                void commandDispatcher.skipToIndex(
                    { server: ctx.server, sessionId: ctx.sessionId },
                    index,
                ),
        ),
};
