import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

// src/renderer/features/jellyfin-remote-target/controller/sessions-poller.ts
import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { findSessionForDevice } from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';
import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

// Safety-net cadence. When the WS push path is healthy the store updates
// happen in real time and this poll lands on already-fresh state. When push
// is broken (server doesn't support SessionsStart, NAT'd WS, receiver mode
// off) the poll alone keeps things working — at lower fidelity than push,
// but never broken.
const POLL_INTERVAL_MS = 2_000;
// After a command is dispatched we want truthful state back as soon as the
// receiver has had a chance to publish PlaybackProgress. A short burst of
// fast polls covers that gap without flooding the server during idle.
const ACTIVE_POLL_INTERVAL_MS = 400;
const ACTIVE_POLL_WINDOW_MS = 4_000;
const OFFLINE_CUTOFF_MS = 60_000;

const perfDebug = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('perf.connect') === '1';
    } catch {
        return false;
    }
};

const perfLog = (label: string, payload: Record<string, unknown>): void => {
    if (!perfDebug()) return;
    console.info('[perf.connect]', label, { ts: performance.now(), ...payload });
};

export interface PollerStartArgs {
    onOffline: (deviceName: string) => void; // toast + fallback to local
    server: ServerListItemWithCredential;
}

export class SessionsPoller {
    private activeUntil = 0;
    private isRunning = false;
    private mode: 'active' | 'idle' = 'idle';
    private offlineSince = 0;

    private startArgs: null | PollerStartArgs = null;

    private timer: null | ReturnType<typeof setTimeout> = null;

    /**
     * Caller signal: a controller command was just dispatched, so flip into
     * fast-poll mode for ACTIVE_POLL_WINDOW_MS. Truthful state lands ~3s
     * later (Jellyfin PlaybackProgress cadence); this lets the controller's
     * mirror catch up without waiting for the next 2s idle tick.
     */
    notifyCommandDispatched(): void {
        this.activeUntil = Date.now() + ACTIVE_POLL_WINDOW_MS;
        perfLog('poller.active', { until: this.activeUntil });
        if (this.mode !== 'active') {
            this.mode = 'active';
            this.rescheduleSoon();
        }
        // Burst a single tick after a brief gap so the receiver has a chance
        // to write its state before we ask. Without the gap we just see our
        // own pre-command snapshot replayed.
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.tick(), 150);
    }

    start(args: PollerStartArgs) {
        this.stop();
        this.isRunning = true;
        this.startArgs = args;
        useRemoteTargetStore.getState().actions.setPollerActive(true);
        // Tick immediately so the picker doesn't show 'No devices' for the
        // poll interval after open.
        void this.tick();
        this.scheduleNext();
    }

    stop() {
        this.isRunning = false;
        this.startArgs = null;
        this.offlineSince = 0;
        this.mode = 'idle';
        this.activeUntil = 0;
        useRemoteTargetStore.getState().actions.setPollerActive(false);
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private currentInterval(): number {
        const now = Date.now();
        if (now < this.activeUntil) {
            this.mode = 'active';
            return ACTIVE_POLL_INTERVAL_MS;
        }
        if (this.mode === 'active') {
            this.mode = 'idle';
            perfLog('poller.idle', {});
        }
        return POLL_INTERVAL_MS;
    }

    private handleMissingTarget(onOffline: (name: string) => void) {
        const state = useRemoteTargetStore.getState();
        const actions = state.actions;
        if (!state.targetDeviceId) return;
        // 'connecting' / 'transferring' are pre-mirror states owned by the
        // picker's connect-toast lifecycle (with its own ~8s timeout). Don't
        // touch them from here — leave the picker to roll back on failure.
        if (state.status === 'connecting' || state.status === 'transferring') return;
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

    private rescheduleSoon(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.tick(), this.currentInterval());
    }

    private scheduleNext(): void {
        if (!this.isRunning) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.tick(), this.currentInterval());
    }

    private async tick(): Promise<void> {
        if (!this.isRunning || !this.startArgs) return;
        const { onOffline, server } = this.startArgs;
        const actions = useRemoteTargetStore.getState().actions;

        const t0 = performance.now();
        let result: { devices: RemoteDevice[]; raws: Record<string, unknown> };
        try {
            result = await remoteTargetApi.listSessionsWithRaw({ server });
        } catch (err) {
            console.warn('[remote-target] poll failed', err);
            actions.setDeviceList([]);
            actions.setPollError(err instanceof Error ? err.message : String(err));
            this.handleMissingTarget(onOffline);
            this.scheduleNext();
            return;
        }
        perfLog('poller.tick', {
            durMs: Math.round(performance.now() - t0),
            mode: this.mode,
        });

        // Hand off to the shared sink so push + poll produce structurally
        // identical store updates. The sink owns the per-device queue cache
        // so the poll doesn't redundantly re-hydrate after a push tick.
        const rawSessions = Object.values(result.raws);
        sessionsSink.apply(rawSessions, server);

        const state = useRemoteTargetStore.getState();
        if (!state.targetDeviceId) {
            this.offlineSince = 0;
            this.scheduleNext();
            return;
        }

        const match = findSessionForDevice(result.devices, state.targetDeviceId);
        if (!match) {
            this.handleMissingTarget(onOffline);
            this.scheduleNext();
            return;
        }
        if (state.status !== 'connected') actions.setStatus('connected');
        this.offlineSince = 0;
        this.scheduleNext();
    }
}

export const sessionsPoller = new SessionsPoller();
