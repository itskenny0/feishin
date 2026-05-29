/**
 * Native raw-TCP transport for mqtt.js on Android.
 *
 * Standard MQTT brokers expose raw TCP on 1883 (8883 TLS) and frequently have
 * NO WebSocket listener, so the WebSocket-only mqtt.js transport can't reach
 * them from the Android WebView. This module wraps a self-contained local
 * Capacitor plugin (TcpSocket — see android/.../TcpSocketPlugin.java) in a
 * readable-stream Duplex usable as an mqtt.js `streamBuilder`.
 *
 * ALL the MQTT protocol logic (LWT, retained, QoS, reconnect, the codec /
 * topics / builders) stays in mqtt.js untouched — only the transport bytes
 * change. mqtt.js writes raw MQTT packets into this Duplex; we base64-encode
 * them onto the native socket. Bytes read from the socket arrive as base64
 * `data` events which we decode and push to the readable side, where mqtt.js's
 * packet parser consumes them.
 *
 * Lifecycle mirrors mqtt.js's own BufferedDuplex: mqtt writes the CONNECT
 * packet immediately (it does not wait for a socket-ready event), so we queue
 * writes until the native `open` resolves, then flush. A connect failure or a
 * socket close surfaces as `error`/`close` on the Duplex, which mqtt.js treats
 * exactly like a refused/closed WebSocket — it tears the client's stream down
 * and reconnects on its own schedule. Nothing here ever throws synchronously,
 * so a refused TCP socket can never black-screen the renderer.
 *
 * The Duplex is constructed from `readable-stream` (mqtt.js's own bundled
 * stream implementation, aliased in the Vite/vitest configs) so we add no npm
 * dependency and stay byte-compatible with what mqtt.js pipes into.
 */
import { Duplex } from 'readable-stream';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);
const warn = (...args: unknown[]) => console.warn('[peer-sync]', ...args);

export interface NativeTcpStreamOptions {
    host: string;
    /** Unique id for this socket; defaults to a random id. */
    id?: string;
    port: number;
    /** When false, accept self-signed TLS certs (LAN brokers). Default true. */
    rejectUnauthorized?: boolean;
    tls?: boolean;
}

/** Handle returned by `plugin.addListener`. */
export interface PluginListenerHandle {
    remove: () => Promise<void> | void;
}

/**
 * The subset of the native TcpSocket plugin we depend on. Kept as a plain
 * interface so tests can supply a mock and so the module never hard-imports
 * `@capacitor/core` (the web/Electron bundles must not pull it in).
 */
export interface TcpSocketPlugin {
    addListener: (
        eventName: 'close' | 'data' | 'error',
        listener: (event: TcpEvent) => void,
    ) => PluginListenerHandle | Promise<PluginListenerHandle>;
    close: (options: { id: string }) => Promise<void>;
    open: (options: {
        host: string;
        id: string;
        port: number;
        rejectUnauthorized?: boolean;
        tls?: boolean;
    }) => Promise<{ id: string }>;
    write: (options: { data: string; id: string }) => Promise<void>;
}

/** Shape of an event payload coming back from the native plugin. */
interface TcpEvent {
    data?: string;
    id?: string;
    message?: string;
}

const uint8ToBase64 = (bytes: Uint8Array): string => {
    // btoa works on binary strings; chunk to avoid blowing the call stack on
    // large packets (retained state snapshots can be a few KB).
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    if (typeof btoa === 'function') return btoa(binary);
    // Node/test fallback.
    return Buffer.from(bytes).toString('base64');
};

const base64ToUint8 = (b64: string): Uint8Array => {
    if (typeof atob === 'function') {
        const binary = atob(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
        return out;
    }
    // Node/test fallback.
    return new Uint8Array(Buffer.from(b64, 'base64'));
};

const toUint8 = (chunk: unknown): Uint8Array => {
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof chunk === 'string') {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(chunk);
        return new Uint8Array(Buffer.from(chunk, 'utf8'));
    }
    // ArrayBuffer / Buffer-like fall through to Uint8Array view.
    return new Uint8Array(chunk as ArrayBufferLike);
};

type QueuedWrite = { cb: (err?: Error) => void; chunk: Uint8Array };

/**
 * A Duplex stream backed by the native TCP socket. Use it as an mqtt.js
 * streamBuilder: `mqtt.connect(() => new NativeTcpStream(plugin, opts), opts)`.
 */
export class NativeTcpStream extends Duplex {
    private isOpen = false;

    private listeners: PluginListenerHandle[] = [];

    private readonly opts: NativeTcpStreamOptions &
        Required<Pick<NativeTcpStreamOptions, 'host' | 'id' | 'port'>>;

    private readonly plugin: TcpSocketPlugin;

    private tornDown = false;

    /** Writes that arrived before the socket finished opening. */
    private writeQueue: QueuedWrite[] = [];

    constructor(plugin: TcpSocketPlugin, options: NativeTcpStreamOptions) {
        // objectMode:false — mqtt.js pipes raw byte chunks through us.
        super();
        this.plugin = plugin;
        this.opts = {
            ...options,
            host: options.host,
            id:
                options.id ??
                `tcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            port: options.port,
        };
        void this.boot();
    }

    _destroy(err: Error | null, cb: (err: Error | null) => void): void {
        if (this.tornDown) {
            cb(err);
            return;
        }
        this.tornDown = true;
        log('native-tcp destroy', { id: this.opts.id });
        this.failQueue(err ?? new Error('native tcp stream destroyed'));
        void this.removeListeners();
        void this.plugin.close({ id: this.opts.id }).catch(() => undefined);
        cb(err);
    }

    _final(cb: (err?: Error) => void): void {
        // mqtt.js called .end(); close the native socket then complete.
        this.plugin
            .close({ id: this.opts.id })
            .then(() => cb())
            .catch(() => cb());
    }

    // Push-driven: the native reader thread emits `data` events on its own.
    _read(): void {
        // no-op
    }

    _write(chunk: unknown, _encoding: string, cb: (err?: Error) => void): void {
        if (this.tornDown) {
            cb(new Error('native tcp stream torn down'));
            return;
        }
        const bytes = toUint8(chunk);
        if (!this.isOpen) {
            this.writeQueue.push({ cb, chunk: bytes });
            return;
        }
        this.sendChunk(bytes, cb);
    }

    private async attachListeners(): Promise<void> {
        const onData = (event: TcpEvent) => {
            if (event.id !== this.opts.id || !event.data) return;
            if (this.tornDown) return;
            const bytes = base64ToUint8(event.data);
            // push returns false on backpressure; the native reader will keep
            // reading regardless (it has its own buffer), which is acceptable
            // for the small MQTT control-frame volume here.
            this.push(Buffer.from(bytes));
        };
        const onClose = (event: TcpEvent) => {
            if (event.id !== this.opts.id) return;
            log('native-tcp close event', { id: this.opts.id });
            this.destroy();
        };
        const onError = (event: TcpEvent) => {
            if (event.id !== this.opts.id) return;
            const message = event.message ?? 'native tcp error';
            warn('native-tcp error event', { id: this.opts.id, message });
            this.destroy(new Error(message));
        };

        const dataHandle = await this.plugin.addListener('data', onData);
        const closeHandle = await this.plugin.addListener('close', onClose);
        const errorHandle = await this.plugin.addListener('error', onError);
        this.listeners.push(dataHandle, closeHandle, errorHandle);
        if (this.tornDown) void this.removeListeners();
    }

    /** Open the native socket + wire its events. Never throws — failures end
     *  the stream so mqtt.js can reconnect (mirrors WS refusal). */
    private async boot(): Promise<void> {
        log('native-tcp boot', {
            host: this.opts.host,
            id: this.opts.id,
            port: this.opts.port,
            tls: Boolean(this.opts.tls),
        });
        try {
            await this.attachListeners();
            await this.plugin.open({
                host: this.opts.host,
                id: this.opts.id,
                port: this.opts.port,
                rejectUnauthorized: this.opts.rejectUnauthorized,
                tls: this.opts.tls,
            });
            if (this.tornDown) {
                // Stream was destroyed mid-open — close the socket we just got.
                void this.plugin.close({ id: this.opts.id }).catch(() => undefined);
                return;
            }
            this.isOpen = true;
            log('native-tcp open', { id: this.opts.id });
            this.flushWriteQueue();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warn('native-tcp open failed', { id: this.opts.id, message });
            // Fail the queued writes and end the stream so mqtt.js retries.
            this.failQueue(new Error(message));
            this.destroy(new Error(message));
        }
    }

    // --- readable-stream Duplex hooks -------------------------------------

    private failQueue(err: Error): void {
        const queued = this.writeQueue;
        this.writeQueue = [];
        for (const item of queued) item.cb(err);
    }

    private flushWriteQueue(): void {
        const queued = this.writeQueue;
        this.writeQueue = [];
        for (const item of queued) this.sendChunk(item.chunk, item.cb);
    }

    private async removeListeners(): Promise<void> {
        const handles = this.listeners;
        this.listeners = [];
        for (const h of handles) {
            try {
                await h.remove();
            } catch {
                // best-effort detach
            }
        }
    }

    private sendChunk(chunk: Uint8Array, cb: (err?: Error) => void): void {
        this.plugin
            .write({ data: uint8ToBase64(chunk), id: this.opts.id })
            .then(() => cb())
            .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                cb(new Error(message));
            });
    }
}

/**
 * Build an mqtt.js `streamBuilder` bound to the native TCP plugin. Pass the
 * resolved host/port/tls; mqtt.js calls the returned function to (re)create
 * the transport on each connect/reconnect.
 */
export const createNativeTcpStreamBuilder = (
    plugin: TcpSocketPlugin,
    options: NativeTcpStreamOptions,
): (() => NativeTcpStream) => {
    return () => new NativeTcpStream(plugin, options);
};

/**
 * Shape of the Electron preload TCP bridge (`window.api.tcpSocket`). Declared
 * structurally here so this module never imports preload types and stays
 * usable in the web bundle (where the bridge is simply absent). The IPC
 * adapter below conforms it to the `TcpSocketPlugin` interface mqtt.js's
 * stream consumes, so Android (Capacitor) and Electron (IPC) share one path.
 */
export interface ElectronTcpSocketBridge {
    addListener: (
        eventName: 'close' | 'data' | 'error',
        listener: (event: TcpEvent) => void,
    ) => { remove: () => void };
    close: (options: { id: string }) => Promise<void>;
    open: (options: {
        host: string;
        id: string;
        port: number;
        rejectUnauthorized?: boolean;
        tls?: boolean;
    }) => Promise<void>;
    write: (options: { data: string; id: string }) => Promise<void>;
}

/**
 * Wrap the Electron `window.api.tcpSocket` IPC bridge as a `TcpSocketPlugin`.
 *
 * The only structural differences from the Capacitor plugin are:
 *   - `open` resolves to `void` over IPC (Capacitor resolves `{ id }`); we
 *     echo back the id the caller passed so `NativeTcpStream` keeps a single
 *     code path.
 *   - `addListener` is synchronous and returns a `{ remove }` handle (vs
 *     Capacitor's promise-or-handle); the interface already permits both.
 *
 * Bytes are base64 in both directions, identical to the native plugin.
 */
export const createElectronTcpSocketPlugin = (
    bridge: ElectronTcpSocketBridge,
): TcpSocketPlugin => ({
    addListener: (eventName, listener) => bridge.addListener(eventName, listener),
    close: (options) => bridge.close(options),
    open: async (options) => {
        await bridge.open(options);
        return { id: options.id };
    },
    write: (options) => bridge.write(options),
});
