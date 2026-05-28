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
});
