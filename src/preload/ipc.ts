import { ipcRenderer } from 'electron';

const removeAllListeners = (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
};

const send = (channel: string, ...args: any[]) => {
    ipcRenderer.send(channel, ...args);
};

// Subscribe helper whose unsubscribe drops only this listener. Use it for
// channels several hooks share (e.g. request-position / request-volume are
// heard by both use-remote and use-mpris), where removeAllListeners would
// also kill the other hook's handler.
export const listen =
    <T>(channel: string) =>
    (cb: (data: T) => void) => {
        const listener = (_: Electron.IpcRendererEvent, data: T) => cb(data);
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    };

const removeListener = (channel: string, listener: (event: any, ...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, listener);
};

export const ipc = {
    removeAllListeners,
    removeListener,
    send,
};

export type Ipc = typeof ipc;
