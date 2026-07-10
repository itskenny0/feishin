// Framework-agnostic controller that keeps the two JS sync pipelines alive while
// the app is backgrounded / locked, by driving the native SyncForegroundService
// plugin from the cache-store progress state.
//
// It is deliberately decoupled from React so it can be unit-tested directly
// (drive store transitions, assert start/throttled-update/stop per kind, and
// that `syncAction` events route to the right cancel). The hook
// (use-sync-foreground-service.tsx) is a thin mount that wires this to the
// renderer lifecycle + the settings gate.
//
// Pipelines:
//   - 'images'    ← cache store `sweep`        (cancel via cancelHydration)
//   - 'downloads' ← cache store `offlineSync`  (cancel via cancelOfflineSync)
//
// The sweep has no standalone exported abort entry point: the whole hydration
// runs under a single AbortController and `cancelHydration()` aborts it and
// clears the sweep state. We reuse that rather than reaching into the sweep's
// private controller — it is the existing, tested cancel for the running sweep
// (Pause is Stop + a resumable flag; a later hydration re-runs and skips
// already-cached items, so cancelling the whole hydration is correct).

import type { SweepProgress } from '/@/renderer/cache/store';

import type { SyncActionEvent, SyncKind, SyncUpdateArgs } from './sync-foreground-bridge';

import {
    addSyncActionListener,
    startSyncService,
    stopSyncService,
    updateSyncService,
} from './sync-foreground-bridge';

import { formatBytes, formatCount } from '/@/renderer/cache/format';
import { cancelOfflineSync } from '/@/renderer/cache/offline-media';
import { useCacheStore } from '/@/renderer/cache/store';
import { cancelHydration } from '/@/renderer/cache/sync';

const TAG = '[sync-service]';

// Throttle notification updates to ~1 Hz: the cache store pushes progress far
// faster (per page / per blob), and re-posting a notification on every tick is
// wasteful and can drop frames on the system UI.
const UPDATE_THROTTLE_MS = 1000;

// Debounce the pipeline-idle → stop transition. The hydration clears its
// `sweep` state between entities (albums done → undefined → artists starts),
// so without a debounce the native foreground service is torn down and
// restarted every few seconds across an 8-entity hydration — battery drain,
// notification flicker, log spam, and a system "Stop FGS timeout". One service
// should span the whole hydration; a brief idle gap between phases must not end
// it.
export const STOP_DEBOUNCE_MS = 5000;

export interface SyncForegroundController {
    /** True if `downloads` was paused via its notification (resumable). */
    isDownloadsPaused(): boolean;
    /** True if `images` was paused via its notification (resumable). */
    isImagesPaused(): boolean;
    /** Tear down: stop both kinds + unsubscribe. Idempotent. */
    stop(): void;
}

interface KindState {
    active: boolean;
    lastUpdateAt: number;
    // Pending debounced stop (set while the pipeline is briefly idle between
    // phases); cleared if the pipeline becomes active again before it fires.
    stopTimer?: ReturnType<typeof setTimeout>;
}

const buildImagesUpdate = (progress: SweepProgress, entity: string): SyncUpdateArgs => {
    const { bytesDownloaded, done, paused, total } = progress;
    const hasTotal = typeof total === 'number' && total > 0;
    const text = paused
        ? 'Paused (offline)'
        : `${formatCount(done)}${hasTotal ? `/${formatCount(total)}` : ''} · ${formatBytes(
              bytesDownloaded,
          )}`;
    return {
        indeterminate: !hasTotal,
        kind: 'images',
        max: hasTotal ? Math.round(total) : 0,
        progress: hasTotal ? Math.round(done) : 0,
        text,
        title: `Syncing ${entity}`,
    };
};

const buildDownloadsUpdate = (
    progress: NonNullable<ReturnType<typeof useCacheStore.getState>['offlineSync']>,
): SyncUpdateArgs => {
    const { bytesDownloaded, done, foundCount, name, phase, total } = progress;
    const hasTotal = typeof total === 'number' && total > 0;
    const text =
        phase === 'enumerating'
            ? `Preparing · ${formatCount(foundCount ?? 0)} songs`
            : `${formatCount(done)}${hasTotal ? `/${formatCount(total)}` : ''} · ${formatBytes(
                  bytesDownloaded,
              )}`;
    return {
        indeterminate: !hasTotal,
        kind: 'downloads',
        max: hasTotal ? Math.round(total) : 0,
        progress: hasTotal ? Math.round(done) : 0,
        text,
        title: `Downloading ${name}`,
    };
};

/**
 * Start the controller: subscribe to the cache store, drive the native service,
 * and wire the notification Pause/Stop actions. Returns a handle whose stop()
 * tears everything down. The caller is responsible for the platform/settings
 * gate — this assumes it should run.
 */
export const startSyncForegroundController = (): SyncForegroundController => {
    const kinds: Record<SyncKind, KindState> = {
        downloads: { active: false, lastUpdateAt: 0 },
        images: { active: false, lastUpdateAt: 0 },
    };
    let imagesPaused = false;
    let downloadsPaused = false;
    let stopped = false;
    let removeActionListener: (() => void) | undefined;

    const handleKind = (
        kind: SyncKind,
        present: boolean,
        update: (() => SyncUpdateArgs) | undefined,
    ): void => {
        const state = kinds[kind];
        if (present && update) {
            // The pipeline is active again — cancel any pending debounced stop
            // (e.g. the next entity sweep started right after the previous one
            // cleared its state) so the one running service is kept alive.
            if (state.stopTimer !== undefined) {
                clearTimeout(state.stopTimer);
                state.stopTimer = undefined;
            }
            if (!state.active) {
                state.active = true;
                state.lastUpdateAt = Date.now();
                console.info(`${TAG} pipeline active`, { kind });
                void startSyncService(kind);
                void updateSyncService(update());
                return;
            }
            // Throttle: re-post the notification at most ~1 Hz.
            const now = Date.now();
            if (now - state.lastUpdateAt >= UPDATE_THROTTLE_MS) {
                state.lastUpdateAt = now;
                void updateSyncService(update());
            }
        } else if (state.active && state.stopTimer === undefined) {
            // Debounce the stop so a brief idle gap between entity phases
            // doesn't churn the native service (see STOP_DEBOUNCE_MS).
            state.stopTimer = setTimeout(() => {
                state.stopTimer = undefined;
                state.active = false;
                console.info(`${TAG} pipeline idle`, { kind });
                void stopSyncService(kind);
            }, STOP_DEBOUNCE_MS);
        }
    };

    const onStoreChange = (): void => {
        if (stopped) return;
        const { offlineSync, sweep } = useCacheStore.getState();
        handleKind(
            'images',
            Boolean(sweep),
            sweep ? () => buildImagesUpdate(sweep.progress, sweep.entity) : undefined,
        );
        handleKind(
            'downloads',
            Boolean(offlineSync),
            offlineSync ? () => buildDownloadsUpdate(offlineSync) : undefined,
        );
    };

    const onAction = (event: SyncActionEvent): void => {
        console.info(`${TAG} action received`, event);
        if (event.kind === 'downloads') {
            // Both pause and stop abort the active download run; pause also marks
            // it resumable so the UI can offer Resume / auto-resume next launch.
            downloadsPaused = event.action === 'pause';
            cancelOfflineSync();
        } else {
            // images: cancelHydration aborts the running sweep + clears state.
            imagesPaused = event.action === 'pause';
            cancelHydration(`sync-notification-${event.action}`);
        }
    };

    const unsubscribeStore = useCacheStore.subscribe(onStoreChange);
    // Wire the notification action listener (async; resolves to a remover).
    void addSyncActionListener(onAction).then((remover) => {
        if (stopped) {
            remover?.();
            return;
        }
        removeActionListener = remover;
    });

    // Reconcile against any state already present at mount (e.g. a sync was
    // already running when the gate flipped on).
    onStoreChange();

    return {
        isDownloadsPaused: () => downloadsPaused,
        isImagesPaused: () => imagesPaused,
        stop: () => {
            if (stopped) return;
            stopped = true;
            unsubscribeStore();
            removeActionListener?.();
            for (const kind of Object.keys(kinds) as SyncKind[]) {
                const state = kinds[kind];
                if (state.stopTimer !== undefined) {
                    clearTimeout(state.stopTimer);
                    state.stopTimer = undefined;
                }
                if (state.active) {
                    state.active = false;
                    void stopSyncService(kind);
                }
            }
            console.info(`${TAG} controller stopped`);
        },
    };
};
