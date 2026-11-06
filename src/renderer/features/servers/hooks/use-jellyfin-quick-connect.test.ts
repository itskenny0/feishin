import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '/@/renderer/api';
import { useJellyfinQuickConnect } from '/@/renderer/features/servers/hooks/use-jellyfin-quick-connect';

vi.mock('/@/renderer/api', () => ({ api: { controller: { authenticate: vi.fn() } } }));
vi.mock('/@/shared/components/toast/toast', () => ({ toast: { error: vi.fn() } }));

const authenticate = vi.mocked(api.controller.authenticate);

describe('useJellyfinQuickConnect', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        authenticate.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    it('does not start polling when cancelled while the code request is in flight', async () => {
        let resolveInitiate: (value: unknown) => void = () => {};
        authenticate.mockImplementationOnce(
            () => new Promise((resolve) => (resolveInitiate = resolve)) as any,
        );
        const onAuthenticated = vi.fn();
        const { result } = renderHook(() => useJellyfinQuickConnect({ onAuthenticated }));

        let pending: Promise<void> = Promise.resolve();
        act(() => {
            pending = result.current.start('http://jf');
        });
        act(() => result.current.stop());
        await act(async () => {
            resolveInitiate({ code: '123456', secret: 's' });
            await pending;
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(result.current.code).toBeNull();
        expect(authenticate).toHaveBeenCalledTimes(1);
        expect(onAuthenticated).not.toHaveBeenCalled();
    });

    it('logs in with the latest onAuthenticated callback', async () => {
        authenticate
            .mockResolvedValueOnce({ code: '123456', secret: 's' } as any)
            .mockResolvedValueOnce(true as any)
            .mockResolvedValueOnce({ credential: 'c' } as any);
        const first = vi.fn();
        const latest = vi.fn();
        const { rerender, result } = renderHook(
            ({ cb }) => useJellyfinQuickConnect({ onAuthenticated: cb }),
            { initialProps: { cb: first } },
        );

        await act(async () => {
            await result.current.start('http://jf');
        });
        rerender({ cb: latest });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });

        expect(first).not.toHaveBeenCalled();
        expect(latest).toHaveBeenCalledWith({ credential: 'c' });
    });
});
