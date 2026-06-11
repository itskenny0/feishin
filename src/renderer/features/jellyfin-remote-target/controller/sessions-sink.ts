import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { safeSessionToDevice } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import {
    findSessionForDevice,
    mirrorSession,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { pickTransportByJellyfinDeviceId } from '/@/renderer/features/peer-sync/controller/transport-selector';

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
// Cap exponential backoff at ~30s so a flaky network doesn't keep us
// re-hydrating every tick forever, while still recovering automatically.
const HYDRATE_MAX_BACKOFF_MS = 30_000;

class SessionsSink {
    private hydrateBackoff: Record<string, { failures: number; nextAttempt: number }> = {};

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

        // Finding 2 + B4: decide a SINGLE owner per lane. When the live lane for
        // this target is MQTT, the MQTT state-mirror is the sole driver of
        // play-state, queue/queueIndex AND the now-playing item (peerStateToMirrored
        // builds a stub Song + stub queue from the wire frame). A Jellyfin poll
        // that was already in flight (or the 10s fallback heartbeat) must therefore
        // NOT write any of these — otherwise the now-playing item (and queue rows)
        // flicker between the rich Jellyfin Song and the bare MQTT stub every ~10s,
        // taking the mirror's duration / cover with them, and the two lanes can
        // disagree on queueIndex.
        //
        // FREEZE FIX (2026-06-11): the only mirror fields `mirrorSession` ever
        // produces are { capabilities, nowPlayingItem, playState } — all of which
        // are dropped when MQTT owns the lane — so `mirrorSession` (and the
        // `jfNormalize.song(session.NowPlayingItem)` inside `deriveNowPlayingItem`)
        // was pure wasted work on EVERY 2Hz sessions-frame while mirroring an MQTT
        // peer. A `/Sessions` payload's embedded `NowPlayingItem` carries no
        // `MediaSources`, so each of those discarded normalizations logged
        // "Jellyfin song retrieved with no media sources" — once per frame, with
        // the full item object. With remote-debug shipping on that warn line is
        // JSON-stringified and written through to a localStorage ring on the main
        // thread twice a second, on top of the 1Hz MQTT applies; on a low-end
        // Android webview that sustained pressure is what walked the renderer into
        // a hard freeze. Resolving the now-playing track is now done ONCE per
        // track change by the MQTT lane's hydration cache, never per frame.
        //
        // So short-circuit BEFORE calling `mirrorSession`: the session-frame still
        // drives the connection bookkeeping above (device list, reconcile,
        // status→connected), but the now-playing/queue/play-state mirror is left
        // entirely to the MQTT lane, and the hydrate is skipped.
        const mqttOwnsLane = pickTransportByJellyfinDeviceId(state.targetDeviceId) === 'mqtt';
        if (mqttOwnsLane) {
            // MQTT owns play-state/queue/now-playing; nothing left for the
            // Jellyfin lane to write or hydrate this frame.
            return;
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
            const now = Date.now();
            const backoff = this.hydrateBackoff[match.deviceId];
            if (backoff && now < backoff.nextAttempt) {
                // Honour the backoff window — skip this hydrate without
                // pretending the cache is fresh, so we'll try again as
                // soon as the window opens. The queueIndex below still
                // updates so the UI tracks the current item even while
                // the queue list is stale. Finding 1: route through
                // applyMirrorFromServer (hold-aware) so a live queueIndex hold
                // from an optimistic skip isn't clobbered by the recomputed
                // (stale) index.
                if (mirror.queueIndex !== -1) {
                    actions.applyMirrorFromServer({ queueIndex: mirror.queueIndex });
                }
                return;
            }
            // Cache the requested id set up-front so a hydrate that returns
            // a shorter list (e.g. a few items 404'd) doesn't permanently
            // disagree with subsequent identical /Sessions payloads and
            // re-trigger hydration on every poll tick.
            const requestedIds = mirror.queueIds ?? [];
            this.prevQueueIdsByDevice[match.deviceId] = requestedIds;
            void mirror
                .hydrateQueue()
                .then((queue) => {
                    // queue list is fresh metadata; queueIndex routes through the
                    // hold-aware path (Finding 1).
                    actions.setMirrored({ queue });
                    actions.applyMirrorFromServer({ queueIndex: mirror.queueIndex });
                    delete this.hydrateBackoff[match.deviceId];
                })
                .catch((err) => {
                    console.warn('[remote-target] queue hydrate failed', err);
                    // Roll back the cache so the next tick can retry — a
                    // transient network failure shouldn't masquerade as
                    // "queue successfully hydrated".
                    delete this.prevQueueIdsByDevice[match.deviceId];
                    // Exponential backoff so a sustained outage doesn't make
                    // the sink hammer the hydrate endpoint on every tick.
                    // The first retry fires immediately — that preserves the
                    // existing contract that a transient single failure
                    // recovers on the next tick. Subsequent failures back
                    // off so a persistent outage doesn't burn the API.
                    const prev = this.hydrateBackoff[match.deviceId];
                    const failures = (prev?.failures ?? 0) + 1;
                    const delay =
                        failures <= 1
                            ? 0
                            : Math.min(
                                  HYDRATE_MAX_BACKOFF_MS,
                                  500 * 2 ** Math.min(failures - 2, 6),
                              );
                    this.hydrateBackoff[match.deviceId] = {
                        failures,
                        nextAttempt: Date.now() + delay,
                    };
                });
        } else if (mirror.queueIds && mirror.queueIds.length === 0) {
            // A2: the target emptied its queue. Push the empty list + reset the
            // index, and sync the per-device cache to [] so `queueChanged`
            // settles on the next tick (no churn while the queue stays empty).
            this.prevQueueIdsByDevice[match.deviceId] = [];
            actions.setMirrored({ queue: [] });
            actions.applyMirrorFromServer({ queueIndex: -1 });
        } else if (mirror.queueIndex !== -1) {
            actions.applyMirrorFromServer({ queueIndex: mirror.queueIndex });
        }
    }

    /** Reset per-device queue cache (e.g. server switch). */
    reset(): void {
        this.prevQueueIdsByDevice = {};
        this.hydrateBackoff = {};
    }
}

export const sessionsSink = new SessionsSink();
