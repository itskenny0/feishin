import type { TFunction } from 'i18next';

import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { toast } from '/@/shared/components/toast/toast';
import { ServerListItemWithCredential } from '/@/shared/types/domain-types';

/**
 * How long we wait for the first /Sessions snapshot containing the target
 * before giving up. Long enough to cover one push tick + a couple of poll
 * intervals (poll cadence is 2s), short enough that the user gets a clear
 * error rather than an indefinite "Connecting…" spinner.
 */
export const CONNECT_TIMEOUT_MS = 8_000;

export interface ConnectTransfer {
    itemIds: string[];
    server: ServerListItemWithCredential;
    startIndex: number | undefined;
    startPositionTicks: number;
}

export interface StartConnectLifecycleArgs {
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
 * Drives the picker's connect-toast lifecycle: tap → optional transfer →
 * first /Sessions mirror → "Playing on" (or error on timeout/failure).
 *
 * The single toast is updated in place via toast.update() so the user sees
 * one staged notification rather than a stack of three.
 */
export const startConnectLifecycle = ({
    deviceId,
    deviceName,
    onRevert,
    sessionId,
    t,
    timeoutMs = CONNECT_TIMEOUT_MS,
    transfer,
}: StartConnectLifecycleArgs): (() => void) => {
    const toastId = `${TOAST_ID_PREFIX}${deviceId}`;
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutHandle: null | ReturnType<typeof setTimeout> = null;

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
    };

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
        finishFailure();
    }, timeoutMs);

    // Stage B — optional transfer. We dispatch the play POST and surface a
    // "Transferring playback…" message; failures of the play POST count as
    // a connect failure.
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

        void remoteTargetApi
            .play({
                itemIds: transfer.itemIds,
                playCommand: 'PlayNow',
                server: transfer.server,
                sessionId,
                startIndex: transfer.startIndex,
                startPositionTicks: transfer.startPositionTicks,
            })
            .catch((err) => {
                console.warn('[remote-target] transfer play failed', err);
                finishFailure();
            });
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
