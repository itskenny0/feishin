import type { RemotePlayCommand } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import i18n from '/@/i18n/i18n';
import {
    RemoteCommandError,
    remoteTargetApi,
} from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
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

const perfDebug = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('perf.connect') === '1';
    } catch {
        return false;
    }
};

let nextDispatchId = 0;

/**
 * Emit a perf trace tied to a single command. The dispatch id threads through
 * dispatch start → publish complete so a burst can be untangled in DevTools.
 * Behind localStorage['perf.connect']==='1' so it's free in normal runs.
 */
const perfMark = (label: string, payload: Record<string, unknown>): void => {
    if (!perfDebug()) return;
    console.info('[perf.connect]', label, { ts: performance.now(), ...payload });
};

const notifyDispatched = (): void => {
    try {
        sessionsPoller.notifyCommandDispatched();
    } catch (err) {
        // Defensive: the poller isn't always mounted (tests, headless flows).
        console.warn('[remote-target] notifyCommandDispatched failed', err);
    }
};

// Per-command toast throttling: when an offline device is targeted, every
// click would otherwise spam a stack of identical error toasts. Limit each
// unique (label, sessionId) tuple to one toast every TOAST_THROTTLE_MS —
// keying on sessionId stops a hot error from device A masking a real, distinct
// error from device B right after a transfer.
const TOAST_THROTTLE_MS = 5_000;
const lastToastByKey: Record<string, number> = {};

/**
 * Test-only probe for the throttle-map size so a regression test can assert
 * the map self-bounds rather than growing one entry per historical sessionId.
 * Not part of the runtime contract.
 */
export const __getToastThrottleSize = (): number => Object.keys(lastToastByKey).length;

const errorStatus = (err: unknown): number | undefined => {
    if (err instanceof RemoteCommandError) return err.status;
    return undefined;
};

const surfaceError = (label: string, sessionId: string, err: unknown): void => {
    const status = errorStatus(err);
    const key = `${label}@${sessionId}`;
    const now = Date.now();
    const last = lastToastByKey[key] ?? 0;
    console.warn('[remote-target] ×', label, { sessionId, status }, err);

    // 401/403: token went bad or the user lost control over this session.
    // Clear the target so the picker can re-pick instead of leaving the user
    // stuck looking at a "Connected" UI that no longer accepts commands.
    if (status === 401 || status === 403) {
        try {
            const state = useRemoteTargetStore.getState();
            if (state.sessionId === sessionId) state.actions.clearTarget();
        } catch (clearErr) {
            console.warn('[remote-target] clearTarget on 401/403 failed', clearErr);
        }
    }

    if (now - last < TOAST_THROTTLE_MS) return;
    // Prune entries past the throttle window before recording the new one so
    // the map self-bounds to keys active within the last TOAST_THROTTLE_MS.
    // sessionIds rotate on every device re-pick / re-login, so without this
    // the map accumulates one permanent entry per (label, historical
    // sessionId) for the app's lifetime. Pruned entries are already stale
    // (their now - last would exceed the window and not suppress a toast
    // anyway), so this never changes live throttling behavior.
    for (const [k, ts] of Object.entries(lastToastByKey)) {
        if (now - ts >= TOAST_THROTTLE_MS) delete lastToastByKey[k];
    }
    lastToastByKey[key] = now;
    const message = err instanceof Error ? err.message : String(err);
    toast.error({
        message,
        title: i18n.t('page.remoteTarget.commandFailed', {
            defaultValue: 'Remote command failed',
        }) as string,
    });
};

const isRetryableStatus = (status: number | undefined): boolean =>
    typeof status === 'number' && status >= 500 && status < 600;

const wrap =
    <Args extends [DispatcherCtx, ...unknown[]]>(
        label: string,
        fn: (...args: Args) => Promise<unknown>,
    ) =>
    async (...args: Args): Promise<void> => {
        const id = ++nextDispatchId;
        const t0 = performance.now();
        const ctx = args[0];
        const sessionId = ctx?.sessionId ?? '';
        perfMark('dispatch.start', { id, label, sessionId });
        // Tell the poller to flip into fast-poll mode immediately so the
        // truthful state mirror lands well within the optimistic-hold
        // window. We do this BEFORE the await so the bookkeeping is set
        // even if the publish itself is slow.
        notifyDispatched();
        try {
            await fn(...args);
            perfMark('dispatch.done', {
                durMs: Math.round(performance.now() - t0),
                id,
                label,
            });
        } catch (err) {
            // Transient 5xx: one quick retry before surfacing. Receivers
            // occasionally bounce a control POST while busy applying the
            // previous one; a single retry under the optimistic-hold window
            // makes the user-visible UI feel solid without spamming the
            // server. 4xx/network errors fall straight through to the toast.
            if (isRetryableStatus(errorStatus(err))) {
                try {
                    await new Promise<void>((res) => setTimeout(res, 250));
                    await fn(...args);
                    perfMark('dispatch.done.retry', {
                        durMs: Math.round(performance.now() - t0),
                        id,
                        label,
                    });
                    return;
                } catch (retryErr) {
                    perfMark('dispatch.error.retry', {
                        durMs: Math.round(performance.now() - t0),
                        id,
                        label,
                    });
                    surfaceError(label, sessionId, retryErr);
                    return;
                }
            }
            perfMark('dispatch.error', {
                durMs: Math.round(performance.now() - t0),
                id,
                label,
            });
            surfaceError(label, sessionId, err);
        }
    };

/**
 * Coalesce a stream of rapid invocations into at most one in-flight call and
 * a trailing call carrying the latest args. Used for volume / seek so a
 * 60-event drag turns into 2 POSTs instead of 60 stacked POSTs that make the
 * receiver "wake up and burst" minutes later.
 *
 * - Leading edge: the first call fires immediately for instant feedback.
 * - Trailing edge: while a call is in flight, additional invocations replace
 *   the queued "latest" arguments; once the in-flight one resolves, we fire
 *   one more call with the latest args (and only the latest).
 *
 * The in-flight / pending slots are KEYED per target sessionId via the
 * supplied `keyFn` so a slow command against device A can never block a fresh
 * command against device B after a transfer. A single shared slot used to
 * silently drop the new device's commands if A's POST never resolved.
 */
type Slot<Args extends unknown[]> = { inFlight: boolean; pending: Args | null };

const coalesceTrailing = <Args extends unknown[]>(
    fn: (...args: Args) => Promise<void>,
    keyFn: (...args: Args) => string,
): ((...args: Args) => void) => {
    const slots = new Map<string, Slot<Args>>();

    const slotFor = (key: string): Slot<Args> => {
        let slot = slots.get(key);
        if (!slot) {
            slot = { inFlight: false, pending: null };
            slots.set(key, slot);
        }
        return slot;
    };

    const run = async (key: string, args: Args): Promise<void> => {
        const slot = slotFor(key);
        slot.inFlight = true;
        try {
            await fn(...args);
        } finally {
            slot.inFlight = false;
            if (slot.pending) {
                const next = slot.pending;
                slot.pending = null;
                void run(key, next);
            } else if (!slot.inFlight) {
                // Free the slot once it's truly idle so a long-lived process
                // doesn't accumulate a per-sessionId map entry forever.
                slots.delete(key);
            }
        }
    };

    return (...args: Args): void => {
        const key = keyFn(...args);
        const slot = slotFor(key);
        if (slot.inFlight) {
            slot.pending = args;
            return;
        }
        void run(key, args);
    };
};

const ctxKey = (ctx: DispatcherCtx, ..._rest: unknown[]): string => ctx.sessionId;

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

    seek: coalesceTrailing(
        wrap('Seek', async (ctx: DispatcherCtx, positionMs: number): Promise<void> => {
            log('Seek', { positionMs, sessionId: ctx.sessionId });
            await remoteTargetApi.sendPlaystate({
                command: 'Seek',
                seekPositionTicks: Math.round(positionMs * 10_000),
                server: ctx.server,
                sessionId: ctx.sessionId,
            });
        }),
        ctxKey,
    ),

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

    setVolume: coalesceTrailing(
        wrap('SetVolume', async (ctx: DispatcherCtx, volume: number): Promise<void> => {
            const clamped = Math.max(0, Math.min(100, Math.round(volume)));
            log('SetVolume', { sessionId: ctx.sessionId, volume: clamped });
            await remoteTargetApi.sendGeneralCommand({
                arguments: { Volume: String(clamped) },
                name: 'SetVolume',
                server: ctx.server,
                sessionId: ctx.sessionId,
            });
        }),
        ctxKey,
    ),

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
