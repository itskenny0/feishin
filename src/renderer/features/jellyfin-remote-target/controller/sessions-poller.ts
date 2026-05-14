// src/renderer/features/jellyfin-remote-target/controller/sessions-poller.ts
import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import {
    findSessionForDevice,
    mirrorSession,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

const POLL_INTERVAL_MS = 3_000;
const OFFLINE_CUTOFF_MS = 60_000;

export interface PollerStartArgs {
    onOffline: (deviceName: string) => void;   // toast + fallback to local
    server: ServerListItemWithCredential;
}

export class SessionsPoller {
    private isRunning = false;
    private offlineSince = 0;
    private startArgs: null | PollerStartArgs = null;
    private timer: null | ReturnType<typeof setInterval> = null;

    /** Track previous queue ids per device to avoid redundant hydrate fetches. */
    private prevQueueIdsByDevice: Record<string, string[]> = {};

    start(args: PollerStartArgs) {
        this.stop();
        this.isRunning = true;
        this.startArgs = args;
        // Tick immediately so the picker doesn't show 'No devices' for 3 s.
        void this.tick();
        this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    }

    stop() {
        this.isRunning = false;
        this.startArgs = null;
        this.offlineSince = 0;
        this.prevQueueIdsByDevice = {};
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick(): Promise<void> {
        if (!this.isRunning || !this.startArgs) return;
        const { server, onOffline } = this.startArgs;
        const actions = useRemoteTargetStore.getState().actions;

        let devices;
        try {
            devices = await remoteTargetApi.listSessions({ server });
        } catch (err) {
            console.warn('[remote-target] poll failed', err);
            this.handleMissingTarget(onOffline);
            return;
        }

        actions.setDeviceList(devices);

        const state = useRemoteTargetStore.getState();
        if (!state.targetDeviceId) {
            // No target → status remains 'idle'.
            this.offlineSince = 0;
            return;
        }

        const match = findSessionForDevice(devices, state.targetDeviceId);
        if (!match) {
            this.handleMissingTarget(onOffline);
            return;
        }

        // Found the device. Recover from reconnecting if needed.
        if (state.status !== 'connected') {
            actions.setStatus('connected');
        }
        this.offlineSince = 0;

        if (state.sessionId !== match.sessionId) {
            // Session id rotates when the device disconnects/reconnects.
            // Update without resetting the rest of the target.
            actions.setTarget({
                capabilities: match.capabilities,
                deviceId: match.deviceId,
                deviceName: match.deviceName,
                sessionId: match.sessionId,
            });
        }

        // For now, build a synthetic "raw" session from the RemoteDevice fields
        // we have. NowPlayingQueue is not exposed on RemoteDevice in v1.
        // Task 10 widens the API to pass raw payloads through.
        const mirrorInput = this.toRawShape(match);
        const mirror = mirrorSession(
            mirrorInput,
            server,
            this.prevQueueIdsByDevice[match.deviceId] ?? [],
        );

        actions.setMirrored(mirror.mirrored);
        if (mirror.hydrateQueue) {
            try {
                const queue = await mirror.hydrateQueue();
                actions.setMirrored({ queue, queueIndex: mirror.queueIndex });
                this.prevQueueIdsByDevice[match.deviceId] = queue.map((s) => s.id);
            } catch (err) {
                console.warn('[remote-target] queue hydrate failed', err);
            }
        } else if (mirror.queueIndex !== -1) {
            actions.setMirrored({ queueIndex: mirror.queueIndex });
        }
    }

    /**
     * The poller throws away the raw session shape via listSessions. For the
     * mirror we approximate it from RemoteDevice. NowPlayingQueue isn't
     * exposed on RemoteDevice in v1 — the poller upgrade in Task 10 will fix
     * this by adding a raw passthrough.
     */
    private toRawShape(d: import('/@/renderer/features/jellyfin-remote-target/types').RemoteDevice) {
        return {
            Id: d.sessionId,
            DeviceId: d.deviceId,
            DeviceName: d.deviceName,
            SupportedCommands: d.capabilities,
            PlayState: { IsPaused: d.isPaused, RepeatMode: 'RepeatNone', VolumeLevel: 100 },
            NowPlayingItem: d.nowPlayingItemId
                ? { Id: d.nowPlayingItemId, Name: d.nowPlayingTitle, Artists: d.nowPlayingArtist ? [d.nowPlayingArtist] : [] }
                : null,
            NowPlayingQueue: [],
        };
    }

    private handleMissingTarget(onOffline: (name: string) => void) {
        const state = useRemoteTargetStore.getState();
        const actions = state.actions;
        if (!state.targetDeviceId) return;
        if (state.status === 'connected' || state.status === 'idle') {
            actions.setStatus('reconnecting');
            this.offlineSince = Date.now();
            return;
        }
        if (Date.now() - this.offlineSince >= OFFLINE_CUTOFF_MS) {
            const name = state.targetDeviceName ?? 'Remote device';
            actions.clearTarget();
            this.offlineSince = 0;
            onOffline(name);
        }
    }
}

export const sessionsPoller = new SessionsPoller();
