import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verify the trailing-coalesce helper that throttles volume/seek into at
 * most one in-flight + one queued call. Without it a 60-event drag floods
 * the server with 60 sequential POSTs, manifesting as the receiver "waking
 * up" minutes later and replaying them all.
 *
 * The helper is unexported; we exercise it via the dispatcher's setVolume
 * which is wired through `coalesceTrailing(wrap(...))`.
 */
describe('command-dispatcher coalescing', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.doUnmock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
        vi.doUnmock('/@/renderer/features/jellyfin-remote-target/controller/sessions-poller');
        vi.doUnmock('/@/shared/components/toast/toast');
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it(
        'collapses a burst of rapid setVolume calls into leading + trailing only',
        { timeout: 15_000 },
        async () => {
            // Mock the API client so we can count calls and resolve in a
            // controlled order.
            const calls: number[] = [];
            let resolveFirst: () => void = () => {};
            const firstStarted = new Promise<void>((resolve) => (resolveFirst = resolve));

            vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
                remoteTargetApi: {
                    sendGeneralCommand: vi.fn(async (args: { arguments?: { Volume?: string } }) => {
                        const v = parseInt(args.arguments?.Volume ?? '0', 10);
                        calls.push(v);
                        if (calls.length === 1) {
                            resolveFirst();
                            // Hold the first call open so the trailing
                            // coalesce path gets exercised.
                            await new Promise<void>((res) => setTimeout(res, 20));
                        }
                    }),
                    sendPlaystate: vi.fn(async () => {}),
                },
            }));

            const { commandDispatcher } =
                await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
            const ctx = {
                server: {
                    credential: 't',
                    id: 's',
                    ndCredential: '',
                    savePassword: false,
                    type: 'jellyfin',
                    url: 'https://x',
                    userId: 'u',
                    username: '',
                } as never,
                sessionId: 'sess',
            };

            // 60 rapid calls — only the first should go out immediately; the
            // rest should collapse into a single trailing call with the LAST
            // value.
            for (let v = 1; v <= 60; v += 1) commandDispatcher.setVolume(ctx, v);
            await firstStarted;
            // Drain the trailing wait.
            await new Promise<void>((res) => setTimeout(res, 60));

            expect(calls.length).toBeGreaterThanOrEqual(2); // leading + at least one trailing
            expect(calls.length).toBeLessThanOrEqual(3); // never more than ~3
            // The very last value must reach the server — that's the whole
            // point of the trailing coalesce.
            expect(calls[calls.length - 1]).toBe(60);
        },
    );

    /**
     * Audit regression: `setMute` was already wired but had no test coverage.
     * Verify it posts a GeneralCommand with the right name and toggles
     * cleanly between Mute and Unmute.
     */
    it('dispatches Mute / Unmute as a GeneralCommand', async () => {
        const calls: Array<{ name: string; sessionId?: string }> = [];
        vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
            remoteTargetApi: {
                sendGeneralCommand: vi.fn(async (args: { name: string; sessionId: string }) => {
                    calls.push({ name: args.name, sessionId: args.sessionId });
                }),
                sendPlaystate: vi.fn(async () => {}),
            },
        }));

        const { commandDispatcher } =
            await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
        const ctx = {
            server: { credential: 't', id: 's', type: 'jellyfin', url: 'x', userId: 'u' } as never,
            sessionId: 'sess',
        };

        await commandDispatcher.setMute(ctx, true);
        await commandDispatcher.setMute(ctx, false);

        expect(calls).toEqual([
            { name: 'Mute', sessionId: 'sess' },
            { name: 'Unmute', sessionId: 'sess' },
        ]);
    });

    /**
     * Audit regression: `skipToIndex` posts a PlayingCommand named
     * `PlaylistIndex` carrying the target queue index. The peer-dispatcher's
     * `skipToIndex` fallback delegates here, so coverage here covers both
     * lanes.
     */
    it('dispatches skipToIndex as a PlaylistIndex Playstate command', async () => {
        const calls: Array<{ command: string; playlistIndex?: number }> = [];
        vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
            remoteTargetApi: {
                sendGeneralCommand: vi.fn(async () => {}),
                sendPlaystate: vi.fn(async (args: { command: string; playlistIndex?: number }) => {
                    calls.push({ command: args.command, playlistIndex: args.playlistIndex });
                }),
            },
        }));

        const { commandDispatcher } =
            await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
        const ctx = {
            server: { credential: 't', id: 's', type: 'jellyfin', url: 'x', userId: 'u' } as never,
            sessionId: 'sess',
        };

        await commandDispatcher.skipToIndex(ctx, 4);
        expect(calls).toEqual([{ command: 'PlaylistIndex', playlistIndex: 4 }]);
    });

    /**
     * Regression: the coalesce helper used a module-level inFlight/pending
     * pair shared across every dispatcher invocation. If a slow setVolume
     * was in flight against device A and the user transferred to device B,
     * the next setVolume(B) would be queued behind A's POST — and silently
     * dropped if A never resolved. The fix keys the coalesce state on the
     * sessionId so a target switch starts a fresh in-flight slot.
     */
    it(
        'does not block setVolume against a new sessionId while a slow call to a previous sessionId is in flight',
        { timeout: 15_000 },
        async () => {
            type Args = { arguments?: { Volume?: string }; sessionId?: string };
            const calls: Array<{ sessionId: string; volume: number }> = [];
            let blockFirst = true;
            let releaseFirst: () => void = () => {};
            const firstStarted = new Promise<void>((resolve) => {
                // resolves the first time the API is hit
                const stopWaiter = setInterval(() => {
                    if (calls.length >= 1) {
                        clearInterval(stopWaiter);
                        resolve();
                    }
                }, 5);
            });

            vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
                remoteTargetApi: {
                    sendGeneralCommand: vi.fn(async (args: Args) => {
                        const volume = parseInt(args.arguments?.Volume ?? '0', 10);
                        const sessionId = args.sessionId ?? '?';
                        calls.push({ sessionId, volume });
                        if (blockFirst) {
                            blockFirst = false;
                            await new Promise<void>((res) => (releaseFirst = res));
                        }
                    }),
                    sendPlaystate: vi.fn(async () => {}),
                },
            }));

            const { commandDispatcher } =
                await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
            const ctxA = {
                server: {
                    credential: 't',
                    id: 's',
                    type: 'jellyfin',
                    url: 'x',
                    userId: 'u',
                } as never,
                sessionId: 'sess-A',
            };
            const ctxB = {
                server: {
                    credential: 't',
                    id: 's',
                    type: 'jellyfin',
                    url: 'x',
                    userId: 'u',
                } as never,
                sessionId: 'sess-B',
            };

            // Drag against device A — fires the leading call, which then hangs.
            commandDispatcher.setVolume(ctxA, 10);
            await firstStarted;
            expect(calls).toEqual([{ sessionId: 'sess-A', volume: 10 }]);

            // User transfers playback to device B, then nudges volume up.
            // The new device MUST get its leading call without waiting on A.
            commandDispatcher.setVolume(ctxB, 42);
            await new Promise<void>((res) => setTimeout(res, 30));

            const bCalls = calls.filter((c) => c.sessionId === 'sess-B');
            expect(bCalls.length).toBeGreaterThanOrEqual(1);
            expect(bCalls[0].volume).toBe(42);

            // Now unblock A so the test cleans up.
            releaseFirst();
            await new Promise<void>((res) => setTimeout(res, 20));
        },
    );

    /**
     * Regression: the controller's mirror was visibly snapping back to the
     * pre-command state because the poller waited up to 2s for its next
     * tick. The dispatcher now nudges the poller into fast-poll mode the
     * moment a command leaves the building, so truthful state lands well
     * within the optimistic-hold window. The contract here is "every
     * command notifies the poller, BEFORE the await".
     */
    it('notifies the sessions poller about every dispatched command', async () => {
        const notifySpy = vi.fn();
        vi.doMock('/@/renderer/features/jellyfin-remote-target/controller/sessions-poller', () => ({
            sessionsPoller: { notifyCommandDispatched: notifySpy },
        }));
        vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
            remoteTargetApi: {
                sendGeneralCommand: vi.fn(async () => {}),
                sendPlaystate: vi.fn(async () => {}),
            },
        }));

        const { commandDispatcher } =
            await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
        const ctx = {
            server: { credential: 't', id: 's', type: 'jellyfin', url: 'x', userId: 'u' } as never,
            sessionId: 'sess',
        };

        await commandDispatcher.pause(ctx);
        await commandDispatcher.unpause(ctx);
        commandDispatcher.setVolume(ctx, 42);
        commandDispatcher.seek(ctx, 12_345);

        // The two coalesced calls fire notifyCommandDispatched on the
        // leading invocation, so we expect 4 notifications: pause, unpause,
        // setVolume, seek.
        expect(notifySpy).toHaveBeenCalledTimes(4);
    });

    /**
     * Audit E5: the per-key error-toast throttle map (lastToastByKey) is keyed
     * by `${label}@${sessionId}` and entries were never evicted. sessionIds
     * rotate on every device re-pick / re-login, so over a long uptime the map
     * grows one permanent entry per (label, historical sessionId). The fix
     * sweeps entries past TOAST_THROTTLE_MS on each write so the map self-bounds
     * to keys active within the window.
     */
    describe('error-toast throttle map bounding', () => {
        const mkCtx = (sessionId: string) => ({
            server: {
                credential: 't',
                id: 's',
                type: 'jellyfin',
                url: 'x',
                userId: 'u',
            } as never,
            sessionId,
        });

        it('caps the throttle map size as sessionIds rotate past the window', async () => {
            vi.useFakeTimers();
            const errorSpy = vi.fn();
            vi.doMock('/@/shared/components/toast/toast', () => ({
                toast: { error: errorSpy, info: vi.fn(), warn: vi.fn() },
            }));
            vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
                // A plain (non-401/403, non-5xx) error reaches the toast/throttle
                // path directly with no retry.
                RemoteCommandError: class extends Error {},
                remoteTargetApi: {
                    sendGeneralCommand: vi.fn(async () => {}),
                    sendPlaystate: vi.fn(async () => {
                        throw new Error('offline');
                    }),
                },
            }));

            const mod =
                await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');

            // 50 distinct sessionIds each erroring once, with the clock pushed
            // past the throttle window between every batch so prior entries are
            // pruned on the next write.
            for (let i = 0; i < 50; i += 1) {
                await mod.commandDispatcher.pause(mkCtx(`sess-${i}`));
                vi.advanceTimersByTime(6_000);
            }

            // Without pruning the map would hold 50 entries. With the sweep it
            // only ever retains the freshly-written key (all prior ones are past
            // the 5s window when the next write occurs).
            expect(mod.__getToastThrottleSize()).toBeLessThanOrEqual(2);
            // Each fresh key fired exactly one toast (50 distinct keys).
            expect(errorSpy).toHaveBeenCalledTimes(50);
        });

        it('still throttles two errors with the same key inside the window to one toast', async () => {
            vi.useFakeTimers();
            const errorSpy = vi.fn();
            vi.doMock('/@/shared/components/toast/toast', () => ({
                toast: { error: errorSpy, info: vi.fn(), warn: vi.fn() },
            }));
            vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
                RemoteCommandError: class extends Error {},
                remoteTargetApi: {
                    sendGeneralCommand: vi.fn(async () => {}),
                    sendPlaystate: vi.fn(async () => {
                        throw new Error('offline');
                    }),
                },
            }));

            const mod =
                await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
            const ctx = mkCtx('sess-same');

            await mod.commandDispatcher.pause(ctx);
            // 4s later — still inside the 5s window: suppressed.
            vi.advanceTimersByTime(4_000);
            await mod.commandDispatcher.pause(ctx);

            expect(errorSpy).toHaveBeenCalledTimes(1);
            // Only the single live key is retained.
            expect(mod.__getToastThrottleSize()).toBe(1);
        });

        it('re-emits a toast for a key whose timestamp predates the window (entry pruned)', async () => {
            vi.useFakeTimers();
            const errorSpy = vi.fn();
            vi.doMock('/@/shared/components/toast/toast', () => ({
                toast: { error: errorSpy, info: vi.fn(), warn: vi.fn() },
            }));
            vi.doMock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
                RemoteCommandError: class extends Error {},
                remoteTargetApi: {
                    sendGeneralCommand: vi.fn(async () => {}),
                    sendPlaystate: vi.fn(async () => {
                        throw new Error('offline');
                    }),
                },
            }));

            const mod =
                await import('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher');
            const ctx = mkCtx('sess-stale');

            await mod.commandDispatcher.pause(ctx);
            expect(errorSpy).toHaveBeenCalledTimes(1);

            // Past the window — the same key must re-emit and the stale entry
            // (here the same key, refreshed) is pruned then rewritten.
            vi.advanceTimersByTime(6_000);
            await mod.commandDispatcher.pause(ctx);
            expect(errorSpy).toHaveBeenCalledTimes(2);
            expect(mod.__getToastThrottleSize()).toBe(1);
        });
    });
});
