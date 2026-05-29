import { describe, expect, it, vi } from 'vitest';

import {
    createElectronTcpSocketPlugin,
    type ElectronTcpSocketBridge,
    NativeTcpStream,
    type PluginListenerHandle,
    type TcpSocketPlugin,
} from '/@/renderer/features/peer-sync/transport/native-tcp-stream';

// Let queued microtasks + the async boot()/open() settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface TcpEvt {
    data?: string;
    id?: string;
    message?: string;
}

const makeMockPlugin = () => {
    const listeners: Record<string, (e: TcpEvt) => void> = {};
    const open = vi.fn(async () => ({ id: 'sock-1' }));
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const addListener = vi.fn((name: string, cb: (e: TcpEvt) => void): PluginListenerHandle => {
        listeners[name] = cb;
        return { remove: vi.fn() };
    });
    const plugin = { addListener, close, open, write } as unknown as TcpSocketPlugin;
    return { listeners, open, plugin, write };
};

const OPTS = { host: 'broker.lan', id: 'sock-1', port: 1883 } as const;

describe('NativeTcpStream', () => {
    it('opens the native socket with the supplied host/port/id', async () => {
        const { open, plugin } = makeMockPlugin();
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        stream.on('error', () => undefined); // swallow if anything goes wrong
        await flush();
        expect(open).toHaveBeenCalledWith(
            expect.objectContaining({ host: 'broker.lan', id: 'sock-1', port: 1883 }),
        );
    });

    it('decodes inbound base64 `data` events and pushes them to the readable side', async () => {
        const { listeners, plugin } = makeMockPlugin();
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        const chunks: Buffer[] = [];
        stream.on('data', (...args: unknown[]) => {
            chunks.push(args[0] as Buffer);
        });
        stream.on('error', () => undefined);
        await flush();

        const payload = Buffer.from([0x10, 0x20, 0x30, 0x40]);
        listeners.data({ data: payload.toString('base64'), id: 'sock-1' });
        await flush();

        expect(Array.from(Buffer.concat(chunks))).toEqual([0x10, 0x20, 0x30, 0x40]);
    });

    it('ignores events addressed to a different socket id', async () => {
        const { listeners, plugin } = makeMockPlugin();
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        const chunks: Buffer[] = [];
        stream.on('data', (...args: unknown[]) => {
            chunks.push(args[0] as Buffer);
        });
        stream.on('error', () => undefined);
        await flush();

        listeners.data({ data: Buffer.from([1]).toString('base64'), id: 'other-socket' });
        await flush();
        expect(chunks).toHaveLength(0);
    });

    it('base64-encodes writes to the plugin once the socket is open', async () => {
        const { plugin, write } = makeMockPlugin();
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        stream.on('error', () => undefined);
        await flush();

        stream.write(Buffer.from([9, 8, 7]));
        await flush();
        expect(write).toHaveBeenCalledWith(
            expect.objectContaining({
                data: Buffer.from([9, 8, 7]).toString('base64'),
                id: 'sock-1',
            }),
        );
    });

    it('queues writes issued before open resolves, then flushes them', async () => {
        const { plugin, write } = makeMockPlugin();
        let release = () => undefined as void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        // Defer the open resolution until we release the gate.
        (plugin as unknown as { open: () => Promise<{ id: string }> }).open = vi.fn(async () => {
            await gate;
            return { id: 'sock-1' };
        });
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        stream.on('error', () => undefined);

        stream.write(Buffer.from([5])); // before open resolves
        await flush();
        expect(write).not.toHaveBeenCalled();

        release();
        await flush();
        await flush();
        expect(write).toHaveBeenCalledWith(
            expect.objectContaining({ data: Buffer.from([5]).toString('base64'), id: 'sock-1' }),
        );
    });

    it('emits error (never throws) when the native open is refused, so mqtt.js can reconnect', async () => {
        const { plugin } = makeMockPlugin();
        (plugin as unknown as { open: () => Promise<{ id: string }> }).open = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        const onError = vi.fn();
        stream.on('error', onError);
        await flush();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('tears the stream down on a native `close` event', async () => {
        const { listeners, plugin } = makeMockPlugin();
        const stream = new NativeTcpStream(plugin, { ...OPTS });
        stream.on('error', () => undefined);
        await flush();

        const onClose = vi.fn();
        stream.on('close', onClose);
        listeners.close({ id: 'sock-1' });
        await flush();
        expect(onClose).toHaveBeenCalled();
    });
});

describe('createElectronTcpSocketPlugin (IPC adapter)', () => {
    const makeBridge = () => {
        const listeners: Record<string, (e: TcpEvt) => void> = {};
        const removed: string[] = [];
        const bridge: ElectronTcpSocketBridge = {
            addListener: vi.fn((name, cb) => {
                listeners[name] = cb;
                return {
                    remove: () => {
                        removed.push(name);
                    },
                };
            }),
            close: vi.fn(async () => undefined),
            // Electron `open` resolves void (no { id }) — the adapter echoes it.
            open: vi.fn(async () => undefined),
            write: vi.fn(async () => undefined),
        };
        return { bridge, listeners, removed };
    };

    it('proxies open and echoes back the supplied id (IPC open resolves void)', async () => {
        const { bridge } = makeBridge();
        const plugin = createElectronTcpSocketPlugin(bridge);
        const result = await plugin.open({ host: 'broker.lan', id: 'sock-9', port: 1883 });
        expect(bridge.open).toHaveBeenCalledWith(
            expect.objectContaining({ host: 'broker.lan', id: 'sock-9', port: 1883 }),
        );
        expect(result).toEqual({ id: 'sock-9' });
    });

    it('proxies write/close and bridges listener events', async () => {
        const { bridge, listeners } = makeBridge();
        const plugin = createElectronTcpSocketPlugin(bridge);

        await plugin.write({ data: 'AQID', id: 'sock-9' });
        expect(bridge.write).toHaveBeenCalledWith({ data: 'AQID', id: 'sock-9' });

        await plugin.close({ id: 'sock-9' });
        expect(bridge.close).toHaveBeenCalledWith({ id: 'sock-9' });

        const onData = vi.fn();
        plugin.addListener('data', onData);
        listeners.data({ data: 'AQID', id: 'sock-9' });
        expect(onData).toHaveBeenCalledWith({ data: 'AQID', id: 'sock-9' });
    });

    it('drives a NativeTcpStream end-to-end over the IPC adapter', async () => {
        const { bridge, listeners } = makeBridge();
        const plugin = createElectronTcpSocketPlugin(bridge);
        const stream = new NativeTcpStream(plugin, {
            host: 'broker.lan',
            id: 'sock-9',
            port: 1883,
        });
        const chunks: Buffer[] = [];
        stream.on('data', (...args: unknown[]) => {
            chunks.push(args[0] as Buffer);
        });
        stream.on('error', () => undefined);
        await flush();

        // Inbound bytes from main → renderer surface on the readable side.
        listeners.data({ data: Buffer.from([0xaa, 0xbb]).toString('base64'), id: 'sock-9' });
        await flush();
        expect(Array.from(Buffer.concat(chunks))).toEqual([0xaa, 0xbb]);

        // Outbound bytes are base64-encoded onto the bridge.
        stream.write(Buffer.from([0x01, 0x02]));
        await flush();
        expect(bridge.write).toHaveBeenCalledWith(
            expect.objectContaining({
                data: Buffer.from([0x01, 0x02]).toString('base64'),
                id: 'sock-9',
            }),
        );
    });
});
