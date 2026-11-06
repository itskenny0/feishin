import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('/@/shared/components/toast/toast', () => ({
    toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { useRemoteStore } from './index';

import { toast } from '/@/shared/components/toast/toast';

class FakeSocket {
    static CONNECTING = 0;
    static instances: FakeSocket[] = [];
    static OPEN = 1;
    listeners: Record<string, (e?: unknown) => void> = {};
    addEventListener = vi.fn((type: string, h: (e?: unknown) => void) => {
        this.listeners[type] = h;
    });
    readyState = FakeSocket.CONNECTING;
    close = vi.fn(() => {
        this.readyState = 3;
    });
    natural = false;
    send = vi.fn();
    constructor() {
        FakeSocket.instances.push(this);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.instances = [];
});

describe('remote store reconnect', () => {
    it('a second reconnect during the credentials fetch leaves exactly one live socket', async () => {
        vi.stubGlobal('WebSocket', FakeSocket);
        const pending: Array<() => void> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise((resolve) =>
                        pending.push(() => resolve({ text: async () => 'Basic x' })),
                    ),
            ),
        );

        // e.g. a double tap on the reconnect button while disconnected.
        const { reconnect } = useRemoteStore.getState().actions;
        reconnect();
        reconnect();
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        pending.forEach((resolve) => resolve());

        await vi.waitFor(() => expect(useRemoteStore.getState().socket).toBeDefined());
        await new Promise((r) => setTimeout(r, 0));
        const live = FakeSocket.instances.filter((s) => s.close.mock.calls.length === 0);
        expect(live).toHaveLength(1);
        expect(useRemoteStore.getState().socket).toBe(live[0]);
    });

    it('toasts when a live connection drops, not on every failed retry while unreachable', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeSocket);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ text: async () => 'Basic x' })),
        );
        vi.mocked(toast.error).mockClear();
        const { reconnect } = useRemoteStore.getState().actions;
        const nextSocket = async () => {
            const n = FakeSocket.instances.length;
            await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(n + 1));
            return FakeSocket.instances[n];
        };

        // Desktop unreachable: each 2s auto-retry fails before opening.
        reconnect();
        let socket = await nextSocket();
        for (let i = 0; i < 3; i++) {
            socket.listeners.close({ code: 1006 });
            vi.advanceTimersByTime(2_000);
            socket = await nextSocket();
        }
        expect(toast.error).not.toHaveBeenCalled();

        socket.listeners.open();
        socket.listeners.close({ code: 1006 });
        expect(toast.error).toHaveBeenCalledTimes(1);

        vi.clearAllTimers();
        vi.useRealTimers();
    });
});
