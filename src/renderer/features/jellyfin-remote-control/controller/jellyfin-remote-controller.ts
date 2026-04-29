import {
    DispatcherDeps,
    dispatchJellyfinMessage,
} from '/@/renderer/features/jellyfin-remote-control/controller/message-dispatcher';
import { JellyfinIncomingMessage } from '/@/renderer/features/jellyfin-remote-control/types';

const KEEPALIVE_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface ControllerStartArgs {
    authHeader: string;
    capabilitiesPayload: unknown;
    deviceId: string;
    dispatcherDeps: DispatcherDeps;
    serverUrl: string;
    token: string;
}

export class JellyfinRemoteController {
    private attempt = 0;
    private capabilitiesSent = false;
    private isStopped = true;
    private keepaliveTimer: null | ReturnType<typeof setInterval> = null;
    private reconnectTimer: null | ReturnType<typeof setTimeout> = null;
    private startArgs: ControllerStartArgs | null = null;
    private ws: null | WebSocket = null;

    async start(args: ControllerStartArgs): Promise<void> {
        this.stop();
        this.isStopped = false;
        this.startArgs = args;
        this.attempt = 0;
        this.capabilitiesSent = false;

        await this.postCapabilities();
        if (this.isStopped) return;
        this.openSocket();
    }

    stop(): void {
        this.isStopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onerror = null;
                this.ws.onclose = null;
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    private buildSocketUrl(args: ControllerStartArgs): string {
        const httpUrl = new URL(args.serverUrl);
        const wsScheme = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const path = httpUrl.pathname.replace(/\/$/, '') + '/socket';
        return `${wsScheme}//${httpUrl.host}${path}?api_key=${encodeURIComponent(
            args.token,
        )}&deviceId=${encodeURIComponent(args.deviceId)}`;
    }

    private openSocket(): void {
        if (!this.startArgs || this.isStopped) return;
        const args = this.startArgs;
        const url = this.buildSocketUrl(args);

        let socket: WebSocket;
        try {
            socket = new WebSocket(url);
        } catch (err) {
            console.warn('[jellyfin-remote] WebSocket constructor failed', err);
            this.scheduleReconnect();
            return;
        }
        this.ws = socket;

        socket.onopen = () => {
            this.attempt = 0;
            if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                }
            }, KEEPALIVE_INTERVAL_MS);
        };

        socket.onmessage = (event) => {
            let parsed: JellyfinIncomingMessage;
            try {
                parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
            } catch {
                return;
            }
            if (!parsed || typeof parsed.MessageType !== 'string') return;
            dispatchJellyfinMessage(parsed, args.dispatcherDeps).catch((err) => {
                console.error('[jellyfin-remote] dispatch failed', err);
            });
        };

        socket.onerror = (event) => {
            console.warn('[jellyfin-remote] socket error', event);
        };

        socket.onclose = () => {
            if (this.keepaliveTimer) {
                clearInterval(this.keepaliveTimer);
                this.keepaliveTimer = null;
            }
            this.ws = null;
            if (!this.isStopped) this.scheduleReconnect();
        };
    }

    private async postCapabilities(): Promise<void> {
        if (!this.startArgs) return;
        const args = this.startArgs;
        try {
            const res = await fetch(`${args.serverUrl}/Sessions/Capabilities/Full`, {
                body: JSON.stringify(args.capabilitiesPayload),
                headers: {
                    Authorization: args.authHeader,
                    'Content-Type': 'application/json',
                },
                method: 'POST',
            });
            if (res.status === 401) {
                console.warn(
                    '[jellyfin-remote] capabilities POST: 401 — disabling for this credential',
                );
                this.isStopped = true;
                return;
            }
            if (!res.ok && res.status !== 204) {
                console.warn(
                    `[jellyfin-remote] capabilities POST returned ${res.status}; continuing anyway`,
                );
            }
            this.capabilitiesSent = true;
        } catch (err) {
            console.warn('[jellyfin-remote] capabilities POST threw; continuing anyway', err);
        }
    }

    private scheduleReconnect(): void {
        if (this.isStopped) return;
        if (this.reconnectTimer) return;
        const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isStopped) return;
            if (!this.capabilitiesSent) {
                // best-effort retry of capabilities; never blocks the socket
                this.postCapabilities();
            }
            this.openSocket();
        }, delay);
    }
}
