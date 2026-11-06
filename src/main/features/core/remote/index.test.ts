// @vitest-environment node
import type { AddressInfo } from 'net';

import { createServer } from 'http';
import { describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('electron', () => ({
    app: { isPackaged: false },
    ipcMain: {
        handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
        on: (channel: string, fn: Handler) => handlers.set(channel, fn),
    },
}));
vi.mock('/@/main/env', () => ({ isLinux: () => false }));
vi.mock('/@/main/index', () => ({ getMainWindow: () => null }));
vi.mock('/@/main/logger', () => ({
    default: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

await import('./index');

describe('remote control server', () => {
    it('reports a port already in use without an uncaught websocket error', async () => {
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, resolve));
        const { port } = blocker.address() as AddressInfo;

        const uncaught = vi.fn();
        process.on('uncaughtException', uncaught);
        try {
            const result = await handlers.get('remote-settings')?.({}, true, port, '', '');
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(result).toMatch(/EADDRINUSE/);
            expect(uncaught).not.toHaveBeenCalled();
        } finally {
            process.removeListener('uncaughtException', uncaught);
            await new Promise((resolve) => blocker.close(resolve));
        }
    });
});
