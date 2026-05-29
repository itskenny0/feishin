/**
 * Raw TCP/TLS socket manager for the renderer's native MQTT transport.
 *
 * The renderer's peer-sync client speaks MQTT over a raw TCP socket when the
 * broker only exposes the standard 1883/8883 listeners (no WebSocket bridge).
 * The browser has no raw-socket API, so on the desktop app we open the socket
 * in the main process with Node's `net`/`tls` and proxy the bytes over IPC.
 * This mirrors the Android Capacitor `TcpSocket` plugin so the renderer can
 * use a single transport abstraction (`TcpSocketPlugin`) across platforms.
 *
 * Protocol (IPC):
 *   - renderer → main  (ipcMain.handle):
 *       tcp-socket-open   { id, host, port, tls, rejectUnauthorized } → void
 *       tcp-socket-write  { id, data: base64 }                        → void
 *       tcp-socket-close  { id }                                      → void
 *   - main → renderer  (webContents.send):
 *       tcp-socket-data   { id, data: base64 }
 *       tcp-socket-close  { id }
 *       tcp-socket-error  { id, message }
 *
 * Sockets are keyed by the renderer-supplied id and bound to the WebContents
 * that opened them, so events always route back to the right window and a
 * destroyed window can't leak sockets. Nothing here throws across the IPC
 * boundary — `open` rejects (surfaced as the handle's rejected promise) only
 * for a synchronous mis-call; runtime failures arrive as `error`/`close`
 * events exactly like the Android plugin, which mqtt.js treats as a closed
 * transport and reconnects on its own schedule.
 */
import type { WebContents } from 'electron';

import { ipcMain } from 'electron';
import { connect as netConnect, Socket } from 'net';
import { connect as tlsConnect, TLSSocket } from 'tls';

const TAG = '[tcp-socket]';
const log = (...args: unknown[]) => console.info(TAG, ...args);
const warn = (...args: unknown[]) => console.warn(TAG, ...args);

interface ActiveSocket {
    socket: Socket | TLSSocket;
    webContents: WebContents;
}

interface OpenOptions {
    host: string;
    id: string;
    port: number;
    rejectUnauthorized?: boolean;
    tls?: boolean;
}

const sockets = new Map<string, ActiveSocket>();

/** Best-effort send to a (possibly destroyed) WebContents. */
const safeSend = (wc: WebContents, channel: string, payload: unknown): void => {
    try {
        if (wc.isDestroyed()) return;
        wc.send(channel, payload);
    } catch (err) {
        warn('send failed', { channel, err: (err as Error).message });
    }
};

const destroySocket = (id: string): void => {
    const entry = sockets.get(id);
    if (!entry) return;
    sockets.delete(id);
    try {
        entry.socket.removeAllListeners();
        entry.socket.destroy();
    } catch (err) {
        warn('destroy failed', { err: (err as Error).message, id });
    }
};

const openSocket = (wc: WebContents, options: OpenOptions): void => {
    const { host, id, port, rejectUnauthorized, tls } = options;
    // A re-open under the same id replaces the previous socket (mqtt.js
    // recreates the stream on reconnect with a fresh id, but guard anyway).
    destroySocket(id);

    log('open', { host, id, port, tls: Boolean(tls) });

    const socket: Socket | TLSSocket = tls
        ? tlsConnect({
              host,
              port,
              // Default true; LAN brokers with self-signed certs pass false.
              rejectUnauthorized: rejectUnauthorized !== false,
          })
        : netConnect({ host, port });

    sockets.set(id, { socket, webContents: wc });

    const onConnectEvent = tls ? 'secureConnect' : 'connect';
    socket.on(onConnectEvent, () => {
        log('connected', { id });
    });
    socket.on('data', (chunk: Buffer) => {
        safeSend(wc, 'tcp-socket-data', { data: chunk.toString('base64'), id });
    });
    socket.on('error', (err: Error) => {
        warn('socket error', { err: err.message, id });
        safeSend(wc, 'tcp-socket-error', { id, message: err.message });
        destroySocket(id);
    });
    socket.on('close', () => {
        log('close', { id });
        safeSend(wc, 'tcp-socket-close', { id });
        sockets.delete(id);
    });

    // Drop every socket a window opened when that window goes away so a
    // navigated/closed renderer can't strand a live broker connection.
    wc.once('destroyed', () => destroySocket(id));
};

const writeSocket = (id: string, dataBase64: string): void => {
    const entry = sockets.get(id);
    if (!entry) {
        warn('write to unknown socket', { id });
        return;
    }
    try {
        entry.socket.write(Buffer.from(dataBase64, 'base64'));
    } catch (err) {
        warn('write failed', { err: (err as Error).message, id });
        safeSend(entry.webContents, 'tcp-socket-error', {
            id,
            message: (err as Error).message,
        });
        destroySocket(id);
    }
};

ipcMain.handle('tcp-socket-open', (event, options: OpenOptions) => {
    openSocket(event.sender, options);
});

ipcMain.handle('tcp-socket-write', (_event, options: { data: string; id: string }) => {
    writeSocket(options.id, options.data);
});

ipcMain.handle('tcp-socket-close', (_event, options: { id: string }) => {
    destroySocket(options.id);
});
