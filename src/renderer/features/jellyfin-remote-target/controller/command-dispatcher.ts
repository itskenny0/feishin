import type { RemotePlayCommand } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';

interface DispatcherCtx {
    server: ServerListItemWithCredential;
    sessionId: string;
}

const log = (label: string, payload: unknown) => {
    console.log('[remote-target] →', label, payload);
};

export const commandDispatcher = {
    next: async (ctx: DispatcherCtx): Promise<void> => {
        log('NextTrack', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'NextTrack',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    pause: async (ctx: DispatcherCtx): Promise<void> => {
        log('Pause', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Pause',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    play: async (
        ctx: DispatcherCtx,
        args: { itemIds: string[]; playCommand?: RemotePlayCommand; startIndex?: number },
    ): Promise<void> => {
        log('Play', { ...args, sessionId: ctx.sessionId });
        await remoteTargetApi.play({
            itemIds: args.itemIds,
            playCommand: args.playCommand ?? 'PlayNow',
            server: ctx.server,
            sessionId: ctx.sessionId,
            startIndex: args.startIndex,
        });
    },

    previous: async (ctx: DispatcherCtx): Promise<void> => {
        log('PreviousTrack', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'PreviousTrack',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    seek: async (ctx: DispatcherCtx, positionMs: number): Promise<void> => {
        log('Seek', { positionMs, sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Seek',
            seekPositionTicks: Math.round(positionMs * 10_000),
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    setMute: async (ctx: DispatcherCtx, mute: boolean): Promise<void> => {
        log(mute ? 'Mute' : 'Unmute', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendGeneralCommand({
            name: mute ? 'Mute' : 'Unmute',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    setVolume: async (ctx: DispatcherCtx, volume: number): Promise<void> => {
        const clamped = Math.max(0, Math.min(100, Math.round(volume)));
        log('SetVolume', { sessionId: ctx.sessionId, volume: clamped });
        await remoteTargetApi.sendGeneralCommand({
            arguments: { Volume: String(clamped) },
            name: 'SetVolume',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    skipToIndex: async (ctx: DispatcherCtx, index: number): Promise<void> => {
        log('PlaylistIndex', { index, sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'PlaylistIndex',
            playlistIndex: index,
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    stop: async (ctx: DispatcherCtx): Promise<void> => {
        log('Stop', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Stop',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    togglePause: async (ctx: DispatcherCtx): Promise<void> => {
        log('PlayPause', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'PlayPause',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },

    unpause: async (ctx: DispatcherCtx): Promise<void> => {
        log('Unpause', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Unpause',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    },
};
