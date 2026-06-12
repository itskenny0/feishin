import type { TFunction } from 'i18next';

import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { peerDispatcher } from '/@/renderer/features/peer-sync/controller/peer-dispatcher';
import {
    getPeerIdForJellyfinDeviceId,
    pickTransportByJellyfinDeviceId,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { toast } from '/@/shared/components/toast/toast';
import { ServerListItemWithCredential } from '/@/shared/types/domain-types';

/**
 * How long we wait for the first /Sessions snapshot containing the target
 * before giving up. Long enough to cover one push tick + a couple of poll
 * intervals (poll cadence is 2s), short enough that the user gets a clear
 * error rather than an indefinite "Connecting…" spinner.
 */
export const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Jellyfin Sessions calls (postPlaying) are flaky on some networks — a single
 * `A network error occurred` would otherwise hard-fail an otherwise-healthy
 * connect. We retry the transfer POST a couple of times with a short backoff
 * before falling back (to the MQTT lane when alive, or to the failure toast
 * for a Jellyfin-only target).
 */
export const TRANSFER_RETRY_ATTEMPTS = 2;
export const TRANSFER_RETRY_BACKOFF_MS = 1_500;

/**
 * Seam for the peer-sync / transport decision so the connect flow can be
 * unit-tested without spinning up the real MQTT graph. Defaults wire straight
 * to the live transport selector + peer dispatcher; tests pass a stub.
 */
export interface ConnectLifecycleDeps {
    /** Resolve the MQTT peerId bound to a Jellyfin Sessions deviceId, if any. */
    getPeerIdForJellyfinDeviceId: (deviceId: string) => string | undefined;
    /** Current authenticated Jellyfin userId — needed to address the peer. */
    getUserId: () => string;
    /** Whether the live transport for this Jellyfin deviceId is the MQTT lane. */
    isMqttLane: (deviceId: string) => boolean;
    /** Dispatch a transfer play through the MQTT lane (peer dispatcher). */
    mqttTransfer: (args: {
        itemIds: string[];
        peerId: string;
        server: ServerListItemWithCredential;
        sessionId: string;
        startIndex: number | undefined;
        userId: string;
    }) => void;
}

export interface ConnectTransfer {
    itemIds: string[];
    server: ServerListItemWithCredential;
    startIndex: number | undefined;
    startPositionTicks: number;
}

const defaultDeps: ConnectLifecycleDeps = {
    getPeerIdForJellyfinDeviceId,
    getUserId: () => useAuthStore.getState().currentServer?.userId ?? '',
    isMqttLane: (deviceId) => pickTransportByJellyfinDeviceId(deviceId) === 'mqtt',
    mqttTransfer: ({ itemIds, peerId, server, sessionId, startIndex, userId }) => {
        peerDispatcher.play(
            { peer: { peerId, userId }, server, sessionId },
            { itemIds, playCommand: 'PlayNow', startIndex },
        );
    },
};

export interface StartConnectLifecycleArgs {
    /** Override the MQTT/transport seam — primarily for tests. */
    deps?: Partial<ConnectLifecycleDeps>;
    deviceId: string;
    deviceName: string;
    /**
     * Called when the connect fails or times out. The caller is responsible
     * for actually reverting the picker state (clearing the target store +
     * the persisted setting) — keeping it as a callback keeps this controller
     * decoupled from settings/store shape.
     */
    onRevert: () => void;
    sessionId: string;
    t: TFunction;
    /** Override the default 8s timeout — primarily for tests. */
    timeoutMs?: number;
    /**
     * If non-null, a transfer-playback POST is dispatched mid-lifecycle and
     * the toast surfaces a "Transferring playback…" stage. Null when we're
     * just attaching to an already-playing target.
     */
    transfer: ConnectTransfer | null;
}

const TOAST_ID_PREFIX = 'remote-target-connect-';

/**
 * Module-level guard so a double-tap of the same device doesn't spawn two
 * parallel lifecycles racing the same toastId. The second call is a no-op
 * and returns the first lifecycle's cleanup so the caller can still bail
 * out symmetrically.
 */
const activeLifecycles = new Map<string, () => void>();

/**
 * Drives the picker's connect-toast lifecycle: tap → optional transfer →
 * first /Sessions mirror → "Playing on" (or error on timeout/failure).
 *
 * Resilience (2026-06-12): a flaky Jellyfin Sessions call must not sink a
 * connect when the same target has a healthy MQTT control lane. When the
 * selected device resolves to a live MQTT peer we complete the connect over
 * MQTT regardless of the Jellyfin POST outcome — the MQTT state-mirror then
 * drives the UI. The failure toast / revert only fires when BOTH lanes are
 * unavailable. The pure-Jellyfin path is unchanged apart from a short retry on
 * the transfer POST.
 *
 * The single toast is updated in place via toast.update() so the user sees
 * one staged notification rather than a stack of three.
 */
export const startConnectLifecycle = ({
    deps,
    deviceId,
    deviceName,
    onRevert,
    sessionId,
    t,
    timeoutMs = CONNECT_TIMEOUT_MS,
    transfer,
}: StartConnectLifecycleArgs): (() => void) => {
    const d: ConnectLifecycleDeps = { ...defaultDeps, ...deps };
    const toastId = `${TOAST_ID_PREFIX}${deviceId}`;
    // Idempotency guard — a double-tap on the same device used to spawn a
    // second subscription that finishSuccess'd against the same toast on
    // status='connected', double-firing the toast.update() and any
    // user-facing instrumentation. Hand the existing cleanup back so the
    // caller's cleanup signature stays stable.
    const existing = activeLifecycles.get(toastId);
    if (existing) return existing;

    // Resolve the lane ONCE at the start so the whole lifecycle agrees on it.
    // A live MQTT peer means presence frames are flowing right now, so we can
    // treat the target as reachable even if Jellyfin HTTP is flaky.
    const mqttLane = d.isMqttLane(deviceId);
    const peerId = mqttLane ? (d.getPeerIdForJellyfinDeviceId(deviceId) ?? '') : '';

    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutHandle: null | ReturnType<typeof setTimeout> = null;
    let retryHandle: null | ReturnType<typeof setTimeout> = null;

    const cleanup = () => {
        settled = true;
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }
        if (retryHandle) {
            clearTimeout(retryHandle);
            retryHandle = null;
        }
        // Drop the idempotency-guard entry once we're done so the next
        // legitimate tap (e.g. user switches away and back) can run.
        if (activeLifecycles.get(toastId) === cleanup) {
            activeLifecycles.delete(toastId);
        }
    };
    activeLifecycles.set(toastId, cleanup);

    const finishSuccess = () => {
        if (settled) return;
        cleanup();
        console.info('[remote-target] connected', deviceName);
        toast.update({
            autoClose: 3500,
            id: toastId,
            loading: false,
            message: t('page.remoteTarget.nowPlayingOn', { deviceName }),
            title: t('common.success', { defaultValue: 'Success' }),
            withCloseButton: true,
        });
    };

    const finishFailure = () => {
        if (settled) return;
        cleanup();
        console.warn('[remote-target] failed to connect', deviceName);
        toast.update({
            autoClose: false,
            id: toastId,
            loading: false,
            message: t('page.remoteTarget.connectFailed', {
                defaultValue: 'Could not connect to {{deviceName}}',
                deviceName,
            }),
            title: t('common.error', { defaultValue: 'Error' }),
            withCloseButton: true,
        });
        // Revert the picker's optimistic state back to local so the user
        // isn't stuck looking at a device-active UI for a connection that
        // never landed.
        onRevert();
    };

    /**
     * Mark the connect as succeeded over the MQTT lane. The MQTT state-mirror
     * (gated on MQTT being the live lane for the sender) becomes the sole
     * driver of the now-playing UI from here. We flip the store to 'connected'
     * directly because the Jellyfin /Sessions snapshot — the usual
     * status='connected' trigger — may be exactly what's flaky.
     */
    const finishViaMqtt = (sendTransfer: boolean) => {
        if (settled) return;
        // Still our target? (the user may have re-picked mid-flight; the store
        // subscription below handles cancel, but a transfer dispatch racing the
        // microtask shouldn't fire against a stale target).
        if (useRemoteTargetStore.getState().targetDeviceId !== deviceId) {
            cleanup();
            return;
        }
        if (sendTransfer && transfer) {
            d.mqttTransfer({
                itemIds: transfer.itemIds,
                peerId,
                server: transfer.server,
                sessionId,
                startIndex: transfer.startIndex,
                userId: d.getUserId(),
            });
        }
        useRemoteTargetStore.getState().actions.setStatus('connected');
        finishSuccess();
    };

    // Stage A — tap. Show the connecting toast immediately and start the
    // timeout clock.
    console.info('[remote-target] connecting', deviceName);
    toast.info({
        autoClose: false,
        id: toastId,
        loading: true,
        message: t('page.remoteTarget.connectingTo', {
            defaultValue: 'Connecting to {{deviceName}}…',
            deviceName,
        }),
        withCloseButton: false,
    });

    timeoutHandle = setTimeout(() => {
        // On timeout, fall back to MQTT if that lane is alive (the Jellyfin
        // /Sessions mirror never landed but the peer is present); otherwise the
        // connect genuinely failed.
        if (mqttLane) {
            console.info('[remote-target] jellyfin transfer failed; connected via MQTT lane');
            finishViaMqtt(false);
            return;
        }
        finishFailure();
    }, timeoutMs);

    // Stage B — optional transfer. We dispatch the play POST and surface a
    // "Transferring playback…" message. A POST failure is retried briefly;
    // if it still fails it only sinks the connect when there's no MQTT lane.
    if (transfer) {
        console.info('[remote-target] transferring', deviceName);
        useRemoteTargetStore.getState().actions.setStatus('transferring');
        toast.update({
            autoClose: false,
            id: toastId,
            loading: true,
            message: t('page.remoteTarget.transferring', {
                defaultValue: 'Transferring playback to {{deviceName}}…',
                deviceName,
            }),
            title: t('common.info', { defaultValue: 'Info' }),
            withCloseButton: false,
        });

        const attemptPlay = (attemptsLeft: number) => {
            if (settled) return;
            void remoteTargetApi
                .play({
                    itemIds: transfer.itemIds,
                    playCommand: 'PlayNow',
                    server: transfer.server,
                    sessionId,
                    startIndex: transfer.startIndex,
                    startPositionTicks: transfer.startPositionTicks,
                })
                // Jellyfin POST landed — wait for the /Sessions mirror to flip
                // 'connected' (Stage C), unchanged from before.
                .catch((err) => {
                    if (settled) return;
                    if (attemptsLeft > 0) {
                        console.warn(
                            '[remote-target] transfer play failed; retrying',
                            (err as Error)?.message,
                        );
                        retryHandle = setTimeout(() => {
                            retryHandle = null;
                            attemptPlay(attemptsLeft - 1);
                        }, TRANSFER_RETRY_BACKOFF_MS);
                        return;
                    }
                    console.warn('[remote-target] transfer play failed', err);
                    // Both retries exhausted. If the MQTT lane is alive, push
                    // the transfer over it and treat the connect as succeeded —
                    // the Jellyfin HTTP flakiness is irrelevant to a healthy
                    // control lane.
                    if (mqttLane) {
                        console.info(
                            '[remote-target] jellyfin transfer failed; connected via MQTT lane',
                        );
                        finishViaMqtt(true);
                        return;
                    }
                    finishFailure();
                });
        };
        attemptPlay(TRANSFER_RETRY_ATTEMPTS);
    } else if (mqttLane) {
        // Stage B' — pure attach over a live MQTT lane. There's no playback to
        // transfer (the target is already playing), and the Jellyfin /Sessions
        // poll that normally flips 'connected' may be flaky. The live MQTT peer
        // is proof enough that the target is reachable, so connect immediately
        // and let the state-mirror paint the UI.
        finishViaMqtt(false);
        return cleanup;
    }

    // Stage C — subscribe for the first-mirror signal. The sink/poller sets
    // status='connected' on the first /Sessions snapshot (push or poll) that
    // contains this device. We also bail out if the user races us and clears
    // the target (e.g. picks Local from another open picker).
    const store = useRemoteTargetStore;
    unsubscribe = store.subscribe((state, prev) => {
        if (settled) return;
        if (state.targetDeviceId !== deviceId) {
            // User cleared / re-picked while we were mid-connect — let the
            // new selection drive its own lifecycle and stop spamming this
            // toast.
            cleanup();
            toast.hide(toastId);
            return;
        }
        if (prev.status !== 'connected' && state.status === 'connected') {
            finishSuccess();
        }
    });

    // Edge case: the store may already be 'connected' if a push frame landed
    // between setTarget and our subscription. Snapshot once to catch that.
    if (store.getState().status === 'connected') {
        finishSuccess();
    }

    return cleanup;
};
