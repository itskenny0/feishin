// @vitest-environment node
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const { handlers, sockets } = vi.hoisted(() => ({
    handlers: new Map<string, Handler>(),
    sockets: [] as { destroy: () => void; destroyed: boolean }[],
}));

vi.mock('electron', () => ({
    ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}));

vi.mock('net', async () => {
    const { EventEmitter: Emitter } = await import('events');
    return {
        connect: () => {
            const socket = Object.assign(new Emitter(), {
                destroy: () => {
                    socket.destroyed = true;
                },
                destroyed: false,
                setKeepAlive: () => {},
                setNoDelay: () => {},
                setTimeout: () => {},
            });
            sockets.push(socket);
            return socket;
        },
    };
});

await import('./index');

describe('tcp-socket bridge', () => {
    it('hooks a window once, however many sockets it opens, and drops them all on destroy', () => {
        const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} });
        const open = handlers.get('tcp-socket-open')!;

        // mqtt.js reconnects with a fresh socket id on every attempt.
        for (let i = 0; i < 25; i++) {
            open({ sender: wc }, { host: 'broker', id: `s${i}`, port: 1883 });
        }

        expect(wc.listenerCount('destroyed')).toBe(1);

        wc.emit('destroyed');
        expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    });
});
