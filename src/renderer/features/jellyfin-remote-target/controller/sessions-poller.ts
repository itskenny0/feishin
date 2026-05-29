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
/**
 * Fallback cadence used while the WS push path reports `connected`. We don't
 * need the 2s tick at all in steady state — the socket pushes every
 * /Sessions change in real time — but a 10s heartbeat catches bugs like a
 * silently-dead WebSocket that browsers won't always tear down, plus it
 * keeps the offline-detection wall clock fed.
 */
const FALLBACK_POLL_INTERVAL_MS = 10_000;
// After a command is dispatched we want truthful state back as soon as the
// receiver has had a chance to publish PlaybackProgress. A short burst of
// fast polls covers that gap without flooding the server during idle.
const ACTIVE_POLL_INTERVAL_MS = 400;
const ACTIVE_POLL_WINDOW_MS = 4_000;
const OFFLINE_CUTOFF_MS = 60_000;
/**
 * How many consecutive polls must miss the target session before we even
 * start the 60s offline clock. A single transient miss (e.g. the device
 * just re-registered with a new sessionId, the receiver is mid-restart, or
 * the response raced a /Sessions refresh server-side) used to instantly
 * flip status to `reconnecting` and start the timer. With a tiny window of
 * tolerance the brief blip is invisible and the 60s budget only counts
 * sustained absences.
 */
const MISS_DEBOUNCE_FRAMES = 3;

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
    private consecutiveMisses = 0;
    /**
     * Set by the hook when the WS push channel reports connected. While true
     * the poll cadence drops from 2s to FALLBACK_POLL_INTERVAL_MS — the push
     * lane is the primary input and the poll is a heartbeat safety net.
     * Active-window fast-poll is still honoured (so a command dispatched in
     * fallback mode still gets the burst), but the steady-state interval is
     * the slower fallback cadence.
     */
    private fallbackMode = false;
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

    /**
     * Force an immediate poll against the currently-running poller without
     * tearing it down. Unlike `start()` this preserves `hasPolledOnce`,
     * `holds`, `fallbackMode`, `pollError`, etc. — refreshing the picker
     * mustn't flash "Searching…" or drop optimistic holds, and mustn't
     * undo the WS-driven fallback-cadence gating.
     *
     * The next normal tick is rescheduled from "now" so the user-visible
     * behaviour is: we just polled, the next scheduled poll is the current
     * interval from now.
     */
    refresh(): void {
        if (!this.isRunning || !this.startArgs) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        void this.tick();
    }

    /**
     * Hook seam: tell the poller whether the WS push channel is currently
     * healthy. When true, the idle cadence relaxes to FALLBACK_POLL_INTERVAL_MS
     * because real-time updates land via push and the poll is a heartbeat
     * safety net. When false, returns to the 2s tick so things keep working
     * if push is broken.
     */
    setFallbackMode(active: boolean): void {
        if (this.fallbackMode === active) return;
        this.fallbackMode = active;
        perfLog('poller.fallbackMode', { active });
        // Reschedule against the new cadence so we don't sit waiting on a 2s
        // timer when the socket just came up (or vice versa).
        if (this.isRunning && this.mode !== 'active') this.rescheduleSoon();
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
        this.consecutiveMisses = 0;
        this.mode = 'idle';
        this.activeUntil = 0;
        this.fallbackMode = false;
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
        return this.fallbackMode ? FALLBACK_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    }

    private handleMissingTarget(onOffline: (name: string) => void) {
        const state = useRemoteTargetStore.getState();
        const actions = state.actions;
        if (!state.targetDeviceId) return;
        // 'connecting' / 'transferring' are pre-mirror states owned by the
        // picker's connect-toast lifecycle (with its own ~8s timeout). Don't
        // touch them from here — leave the picker to roll back on failure.
        if (state.status === 'connecting' || state.status === 'transferring') return;

        // Tolerate a brief blip before starting the offline clock — a single
        // poll missing the target session was enough to flip status to
        // `reconnecting` and burn into the 60s offline budget, even though
        // the next tick usually carried the session back. Require the miss
        // to repeat for MISS_DEBOUNCE_FRAMES before reacting.
        this.consecutiveMisses += 1;
        if (this.consecutiveMisses < MISS_DEBOUNCE_FRAMES) return;

        if (state.status === 'connected' || state.status === 'idle') {
            actions.setStatus('reconnecting');
            this.offlineSince = Date.now();
            return;
        }
        if (Date.now() - this.offlineSince >= OFFLINE_CUTOFF_MS) {
            const name = state.targetDeviceName ?? 'Remote device';
            actions.clearTarget();
            this.offlineSince = 0;
            this.consecutiveMisses = 0;
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
        // Snapshot the generation identity at entry. start() always assigns a
        // brand-new startArgs object (the hook passes a fresh literal each
        // effect run), so comparing identity after the await reliably detects
        // a stop()/restart that happened while we were in flight — even if
        // isRunning flipped back to true for a new server.
        const args = this.startArgs;
        if (!this.isRunning || !args) return;
        const { onOffline, server } = args;
        const actions = useRemoteTargetStore.getState().actions;
        const targetIdBefore = useRemoteTargetStore.getState().targetDeviceId;

        const t0 = performance.now();
        let result: { devices: RemoteDevice[]; raws: Record<string, unknown> };
        try {
            result = await remoteTargetApi.listSessionsWithRaw({ server });
        } catch (err) {
            // Drop a failed-poll result that belongs to a stopped/restarted
            // generation so a stale server-A error can't set pollError or
            // wipe server-B's freshly-fetched device list.
            if (!this.isRunning || this.startArgs !== args) return;
            console.warn('[remote-target] poll failed', err);
            actions.setPollError(err instanceof Error ? err.message : String(err));
            // A failed poll is NOT a confirmed miss of the target session —
            // we have no information about who's online. Surface the error
            // banner but don't wipe the device list when a target is set
            // (the user is staring at it). On sustained failure the next
            // successful poll will notice the target is absent and run the
            // missing-target ladder.
            if (!targetIdBefore) {
                actions.setDeviceList([]);
            }
            this.scheduleNext();
            return;
        }
        // Drop a result that belongs to a poller generation that has since
        // been stopped or restarted (e.g. a server A→B switch landed while
        // this poll awaited server A's /Sessions). Without this guard the
        // stale server-A response would overwrite server-B's device list and
        // could mark a server-A device as the connected target.
        if (!this.isRunning || this.startArgs !== args) return;

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
            this.consecutiveMisses = 0;
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
        this.consecutiveMisses = 0;
        this.scheduleNext();
    }
}

export const sessionsPoller = new SessionsPoller();
