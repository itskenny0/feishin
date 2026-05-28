import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { safeSessionToDevice } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import {
    findSessionForDevice,
    mirrorSession,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

const perfDebug = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('perf.connect') === '1';
    } catch {
        return false;
    }
};

const perfMark = (label: string, payload: Record<string, unknown>): void => {
    if (!perfDebug()) return;
    console.info('[perf.connect]', label, { ts: performance.now(), ...payload });
};

/**
 * Shared sessions-sink used by BOTH the WS push handler and the poller.
 *
 * Keeps per-device previous queue ids so we only re-hydrate the visible
 * queue when ids actually change. Stateful by design — there's one
 * application-wide sink and both consumers feed it.
 */
class SessionsSink {
    private prevQueueIdsByDevice: Record<string, string[]> = {};

    /**
     * Apply a `/Sessions` payload (whether from poll or WS push) to the
     * store. Pure idempotent — calling with the same payload twice produces
     * the same state. The `applyMirrorFromServer` action respects per-field
     * optimistic holds so this can't clobber in-flight optimistic updates.
     */
    apply(rawSessions: unknown[], server: ServerListItemWithCredential): void {
        const actions = useRemoteTargetStore.getState().actions;

        const devices: RemoteDevice[] = [];
        const rawsBySessionId: Record<string, unknown> = {};
        for (const s of rawSessions) {
            const dev = safeSessionToDevice(s);
            if (!dev) continue;
            devices.push(dev);
            rawsBySessionId[dev.sessionId] = s;
        }

        actions.setDeviceList(devices);
        actions.setPollError(null);

        const state = useRemoteTargetStore.getState();
        if (!state.targetDeviceId) return;

        const match = findSessionForDevice(devices, state.targetDeviceId);
        if (!match) {
            // Don't change status here — the poller owns the "reconnecting →
            // offline" transition because it knows about time. Push just
            // means "the current snapshot doesn't include this device".
            return;
        }

        if (state.sessionId !== match.sessionId) {
            actions.reconcileSession({
                capabilities: match.capabilities,
                deviceName: match.deviceName,
                sessionId: match.sessionId,
            });
        } else if (state.status !== 'connected') {
            // First-mirror signal: a /Sessions snapshot (push OR poll) found
            // the target session for the first time after the user picked it,
            // so we can flip 'connecting' / 'transferring' / 'reconnecting'
            // to 'connected'. The picker's connect-toast listens for this.
            console.info('[remote-target] connected', match.deviceName);
            actions.setStatus('connected');
        }

        const raw = rawsBySessionId[match.sessionId];
        const mirror = mirrorSession(raw, server, this.prevQueueIdsByDevice[match.deviceId] ?? []);
        perfMark('mirror.apply.jellyfin', {
            isPaused: mirror.mirrored.playState?.isPaused,
            positionMs: mirror.mirrored.playState?.positionMs,
            volume: mirror.mirrored.playState?.volume,
        });
        actions.applyMirrorFromServer(mirror.mirrored);

        if (mirror.hydrateQueue) {
            // Cache the requested id set up-front so a hydrate that returns
            // a shorter list (e.g. a few items 404'd) doesn't permanently
            // disagree with subsequent identical /Sessions payloads and
            // re-trigger hydration on every poll tick.
            const requestedIds = mirror.queueIds ?? [];
            this.prevQueueIdsByDevice[match.deviceId] = requestedIds;
            void mirror
                .hydrateQueue()
                .then((queue) => {
                    actions.setMirrored({ queue, queueIndex: mirror.queueIndex });
                })
                .catch((err) => {
                    console.warn('[remote-target] queue hydrate failed', err);
                    // Roll back the cache so the next tick retries — a
                    // transient network failure shouldn't masquerade as
                    // "queue successfully hydrated".
                    delete this.prevQueueIdsByDevice[match.deviceId];
                });
        } else if (mirror.queueIndex !== -1) {
            actions.setMirrored({ queueIndex: mirror.queueIndex });
        }
    }

    /** Reset per-device queue cache (e.g. server switch). */
    reset(): void {
        this.prevQueueIdsByDevice = {};
    }
}

export const sessionsSink = new SessionsSink();
