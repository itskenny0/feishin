import { describe, expect, it, vi } from 'vitest';

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
    it('collapses a burst of rapid setVolume calls into leading + trailing only', async () => {
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
                        await new Promise<void>((res) => setTimeout(res, 50));
                    }
                }),
                sendPlaystate: vi.fn(async () => {}),
            },
        }));

        // Reset module registry so the mock takes effect.
        vi.resetModules();
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
        await new Promise<void>((res) => setTimeout(res, 100));

        expect(calls.length).toBeGreaterThanOrEqual(2); // leading + at least one trailing
        expect(calls.length).toBeLessThanOrEqual(3); // never more than ~3
        // The very last value must reach the server — that's the whole
        // point of the trailing coalesce.
        expect(calls[calls.length - 1]).toBe(60);
    });
});
