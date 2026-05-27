import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

// src/renderer/features/jellyfin-remote-target/controller/sessions-poller.ts
import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import {
    findSessionForDevice,
    mirrorSession,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

const POLL_INTERVAL_MS = 3_000;
const OFFLINE_CUTOFF_MS = 60_000;

export interface PollerStartArgs {
    onOffline: (deviceName: string) => void; // toast + fallback to local
    server: ServerListItemWithCredential;
}

export class SessionsPoller {
    private isRunning = false;
    private offlineSince = 0;
    /** Track previous queue ids per device to avoid redundant hydrate fetches. */
    private prevQueueIdsByDevice: Record<string, string[]> = {};
    /** Raw session payloads indexed by deviceId, populated each tick. */
    private rawByDeviceId: Record<string, unknown> = {};

    private startArgs: null | PollerStartArgs = null;

    private timer: null | ReturnType<typeof setInterval> = null;

    start(args: PollerStartArgs) {
        this.stop();
        this.isRunning = true;
        this.startArgs = args;
        useRemoteTargetStore.getState().actions.setPollerActive(true);
        // Tick immediately so the picker doesn't show 'No devices' for 3 s.
        void this.tick();
        this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    }

    stop() {
        this.isRunning = false;
        this.startArgs = null;
        this.offlineSince = 0;
        this.prevQueueIdsByDevice = {};
        this.rawByDeviceId = {};
        useRemoteTargetStore.getState().actions.setPollerActive(false);
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
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

    private async tick(): Promise<void> {
        if (!this.isRunning || !this.startArgs) return;
        const { onOffline, server } = this.startArgs;
        const actions = useRemoteTargetStore.getState().actions;

        let result: { devices: RemoteDevice[]; raws: Record<string, unknown> };
        try {
            result = await remoteTargetApi.listSessionsWithRaw({ server });
        } catch (err) {
            console.warn('[remote-target] poll failed', err);
            // Empty the device list on poll failure and record the error so
            // the picker can show *why* it's empty (auth issue, network down,
            // bad URL, etc.) instead of pretending there are simply no other
            // clients online.
            actions.setDeviceList([]);
            actions.setPollError(err instanceof Error ? err.message : String(err));
            this.handleMissingTarget(onOffline);
            return;
        }

        // Successful poll — clear any prior error.
        actions.setPollError(null);
        actions.setDeviceList(result.devices);
        this.rawByDeviceId = {};
        for (const d of result.devices) {
            this.rawByDeviceId[d.deviceId] = result.raws[d.sessionId];
        }

        const state = useRemoteTargetStore.getState();
        if (!state.targetDeviceId) {
            this.offlineSince = 0;
            return;
        }

        const match = findSessionForDevice(result.devices, state.targetDeviceId);
        if (!match) {
            this.handleMissingTarget(onOffline);
            return;
        }

        if (state.status !== 'connected') actions.setStatus('connected');
        this.offlineSince = 0;

        if (state.sessionId !== match.sessionId) {
            actions.reconcileSession({
                capabilities: match.capabilities,
                deviceName: match.deviceName,
                sessionId: match.sessionId,
            });
        }

        const raw = this.rawByDeviceId[match.deviceId];
        const mirror = mirrorSession(raw, server, this.prevQueueIdsByDevice[match.deviceId] ?? []);
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
}

export const sessionsPoller = new SessionsPoller();
