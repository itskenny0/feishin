import type { IpcRendererEvent } from 'electron';

import { ipcRenderer } from 'electron';

/**
 * Renderer-facing bridge for the main-process raw TCP/TLS socket manager.
 *
 * Mirrors the Android Capacitor `TcpSocket` plugin surface so the renderer's
 * native MQTT transport (`TcpSocketPlugin`) can drive either one. Bytes cross
 * the IPC boundary base64-encoded in both directions. `addListener` registers
 * a callback for the push events the main process emits (data/close/error) and
 * returns a handle whose `remove()` detaches it.
 *
 * Web/PWA builds have no `window.api`, so this object simply doesn't exist
 * there — the renderer falls back to the WebSocket transport, which is the
 * only raw-socket-free option a browser can offer.
 */

export interface TcpSocketEvent {
    data?: string;
    id?: string;
    message?: string;
}

export interface TcpSocketListenerHandle {
    remove: () => void;
}

export interface TcpSocketOpenOptions {
    host: string;
    id: string;
    port: number;
    rejectUnauthorized?: boolean;
    tls?: boolean;
}

type TcpSocketEventName = 'close' | 'data' | 'error';

const CHANNELS: Record<TcpSocketEventName, string> = {
    close: 'tcp-socket-close',
    data: 'tcp-socket-data',
    error: 'tcp-socket-error',
};

const open = (options: TcpSocketOpenOptions): Promise<void> =>
    ipcRenderer.invoke('tcp-socket-open', options);

const write = (options: { data: string; id: string }): Promise<void> =>
    ipcRenderer.invoke('tcp-socket-write', options);

const close = (options: { id: string }): Promise<void> =>
    ipcRenderer.invoke('tcp-socket-close', options);

const addListener = (
    eventName: TcpSocketEventName,
    listener: (event: TcpSocketEvent) => void,
): TcpSocketListenerHandle => {
    const channel = CHANNELS[eventName];
    const handler = (_event: IpcRendererEvent, payload: TcpSocketEvent) => listener(payload);
    ipcRenderer.on(channel, handler);
    return {
        remove: () => ipcRenderer.removeListener(channel, handler),
    };
};

export const tcpSocket = {
    addListener,
    close,
    open,
    write,
};

export type TcpSocketBridge = typeof tcpSocket;
