import type { RemotePlayCommand } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import i18n from '/@/i18n/i18n';
import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { toast } from '/@/shared/components/toast/toast';

interface DispatcherCtx {
    server: ServerListItemWithCredential;
    sessionId: string;
}

// Always-on so the user can show us what's happening in DevTools when a
// control silently does nothing. Cheap (one console.log per click).
const log = (label: string, payload: unknown) => {
    console.log('[remote-target] →', label, payload);
};

// Per-command toast throttling: when an offline device is targeted, every
// click would otherwise spam a stack of identical error toasts. Limit each
// unique command label to one toast every 5 seconds.
const lastToastByLabel: Record<string, number> = {};

const surfaceError = (label: string, err: unknown): void => {
    const now = Date.now();
    const last = lastToastByLabel[label] ?? 0;
    console.warn('[remote-target] ×', label, err);
    if (now - last < 5_000) return;
    lastToastByLabel[label] = now;
    const message = err instanceof Error ? err.message : String(err);
    toast.error({
        message,
        title: i18n.t('page.remoteTarget.commandFailed', {
            defaultValue: 'Remote command failed',
        }) as string,
    });
};

const wrap =
    <Args extends unknown[]>(label: string, fn: (...args: Args) => Promise<unknown>) =>
    async (...args: Args): Promise<void> => {
        try {
            await fn(...args);
        } catch (err) {
            surfaceError(label, err);
        }
    };

export const commandDispatcher = {
    next: wrap('NextTrack', async (ctx: DispatcherCtx): Promise<void> => {
        log('NextTrack', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'NextTrack',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    pause: wrap('Pause', async (ctx: DispatcherCtx): Promise<void> => {
        log('Pause', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Pause',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    play: wrap(
        'Play',
        async (
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
    ),

    previous: wrap('PreviousTrack', async (ctx: DispatcherCtx): Promise<void> => {
        log('PreviousTrack', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'PreviousTrack',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    seek: wrap('Seek', async (ctx: DispatcherCtx, positionMs: number): Promise<void> => {
        log('Seek', { positionMs, sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Seek',
            seekPositionTicks: Math.round(positionMs * 10_000),
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    setMute: wrap('Mute', async (ctx: DispatcherCtx, mute: boolean): Promise<void> => {
        log(mute ? 'Mute' : 'Unmute', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendGeneralCommand({
            name: mute ? 'Mute' : 'Unmute',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    setRepeat: wrap('SetRepeatMode', async (ctx: DispatcherCtx, mode: string): Promise<void> => {
        log('SetRepeatMode', { mode, sessionId: ctx.sessionId });
        await remoteTargetApi.sendGeneralCommand({
            arguments: { RepeatMode: mode },
            name: 'SetRepeatMode',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    setShuffle: wrap(
        'SetShuffleQueue',
        async (ctx: DispatcherCtx, shuffle: boolean): Promise<void> => {
            log('SetShuffleQueue', { sessionId: ctx.sessionId, shuffle });
            await remoteTargetApi.sendGeneralCommand({
                arguments: { ShuffleMode: shuffle ? 'Shuffle' : 'Sorted' },
                name: 'SetShuffleQueue',
                server: ctx.server,
                sessionId: ctx.sessionId,
            });
        },
    ),

    setVolume: wrap('SetVolume', async (ctx: DispatcherCtx, volume: number): Promise<void> => {
        const clamped = Math.max(0, Math.min(100, Math.round(volume)));
        log('SetVolume', { sessionId: ctx.sessionId, volume: clamped });
        await remoteTargetApi.sendGeneralCommand({
            arguments: { Volume: String(clamped) },
            name: 'SetVolume',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    skipToIndex: wrap('PlaylistIndex', async (ctx: DispatcherCtx, index: number): Promise<void> => {
        log('PlaylistIndex', { index, sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'PlaylistIndex',
            playlistIndex: index,
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    stop: wrap('Stop', async (ctx: DispatcherCtx): Promise<void> => {
        log('Stop', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Stop',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    togglePause: wrap('PlayPause', async (ctx: DispatcherCtx): Promise<void> => {
        log('PlayPause', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'PlayPause',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),

    unpause: wrap('Unpause', async (ctx: DispatcherCtx): Promise<void> => {
        log('Unpause', { sessionId: ctx.sessionId });
        await remoteTargetApi.sendPlaystate({
            command: 'Unpause',
            server: ctx.server,
            sessionId: ctx.sessionId,
        });
    }),
};
