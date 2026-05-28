import type { MockInstance } from 'vitest';

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { startConnectLifecycle } from '/@/renderer/features/jellyfin-remote-target/controller/connect-lifecycle';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { toast } from '/@/shared/components/toast/toast';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

const jellyfinServer: ServerListItemWithCredential = {
    credential: 'cred',
    id: 'srv-1',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'http://localhost',
    userId: 'user-1',
    username: 'demo',
};

// Production t() resolves these from the en.json bundle; in tests we
// reproduce the relevant strings inline so assertions check the user-visible
// copy rather than untranslated keys.
const STRINGS: Record<string, string> = {
    'page.remoteTarget.connectFailed': 'Could not connect to {{deviceName}}',
    'page.remoteTarget.connectingTo': 'Connecting to {{deviceName}}…',
    'page.remoteTarget.nowPlayingOn': 'Now playing on {{deviceName}}',
    'page.remoteTarget.transferring': 'Transferring playback to {{deviceName}}…',
};
const t = ((key: string, opts?: Record<string, unknown>) => {
    const tpl =
        STRINGS[key] ??
        (opts && typeof opts.defaultValue === 'string' ? (opts.defaultValue as string) : key);
    return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''));
}) as never;

type AnySpy = MockInstance<(...args: any[]) => any>;

interface ToastArg {
    autoClose?: boolean | number;
    loading?: boolean;
    message?: string;
}

let toastInfo: AnySpy;
let toastUpdate: AnySpy;
let toastHide: AnySpy;
let playSpy: AnySpy;

const firstArgs = (spy: AnySpy): ToastArg[] => spy.mock.calls.map((c) => c[0] as ToastArg);

beforeEach(() => {
    vi.useFakeTimers();
    toastInfo = vi.spyOn(toast, 'info').mockReturnValue('toast-id' as unknown as undefined);
    toastUpdate = vi.spyOn(toast, 'update').mockReturnValue('toast-id');
    toastHide = vi.spyOn(toast, 'hide').mockReturnValue('toast-id');
    playSpy = vi.spyOn(remoteTargetApi, 'play').mockResolvedValue(undefined as never);
});

afterEach(() => {
    vi.useRealTimers();
    toastInfo.mockRestore();
    toastUpdate.mockRestore();
    toastHide.mockRestore();
    playSpy.mockRestore();
    useRemoteTargetStore.getState().actions.clearTarget();
});

const setTarget = () => {
    useRemoteTargetStore.getState().actions.setTarget({
        capabilities: [],
        deviceId: 'dev-1',
        deviceName: 'Living Room',
        sessionId: 'sess-1',
    });
};

describe('startConnectLifecycle', () => {
    it('shows a "Connecting to" toast immediately on tap', () => {
        setTarget();
        startConnectLifecycle({
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            onRevert: () => {},
            sessionId: 'sess-1',
            t,
            transfer: null,
        });
        expect(toastInfo).toHaveBeenCalledTimes(1);
        const [call] = firstArgs(toastInfo);
        expect(call.message).toContain('Connecting to Living Room');
        expect(call.loading).toBe(true);
    });

    it('updates to "Now playing on" once the store flips to connected', () => {
        setTarget();
        startConnectLifecycle({
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            onRevert: () => {},
            sessionId: 'sess-1',
            t,
            transfer: null,
        });
        // First-mirror signal.
        act(() => {
            useRemoteTargetStore.getState().actions.setStatus('connected');
        });
        const successCall = firstArgs(toastUpdate).find(
            (arg) => typeof arg.message === 'string' && arg.message.includes('Now playing on'),
        );
        expect(successCall).toBeDefined();
        expect(successCall!.loading).toBe(false);
    });

    it('surfaces a "Transferring playback" stage when a transfer is supplied', () => {
        setTarget();
        startConnectLifecycle({
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            onRevert: () => {},
            sessionId: 'sess-1',
            t,
            transfer: {
                itemIds: ['s1'],
                server: jellyfinServer,
                startIndex: undefined,
                startPositionTicks: 0,
            },
        });
        expect(playSpy).toHaveBeenCalledTimes(1);
        const transferCall = firstArgs(toastUpdate).find(
            (arg) =>
                typeof arg.message === 'string' && arg.message.includes('Transferring playback'),
        );
        expect(transferCall).toBeDefined();
        expect(useRemoteTargetStore.getState().status).toBe('transferring');
    });

    it('shows an error toast and reverts when the connect times out', () => {
        setTarget();
        const onRevert = vi.fn();
        startConnectLifecycle({
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            onRevert,
            sessionId: 'sess-1',
            t,
            timeoutMs: 1_000,
            transfer: null,
        });
        // Drain the timeout.
        act(() => {
            vi.advanceTimersByTime(1_500);
        });
        const failCall = firstArgs(toastUpdate).find(
            (arg) => typeof arg.message === 'string' && arg.message.includes('Could not connect'),
        );
        expect(failCall).toBeDefined();
        expect(failCall!.autoClose).toBe(false);
        expect(onRevert).toHaveBeenCalledTimes(1);
    });

    it('reverts when the transfer-play POST fails', async () => {
        playSpy.mockRejectedValueOnce(new Error('boom'));
        setTarget();
        const onRevert = vi.fn();
        startConnectLifecycle({
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            onRevert,
            sessionId: 'sess-1',
            t,
            transfer: {
                itemIds: ['s1'],
                server: jellyfinServer,
                startIndex: undefined,
                startPositionTicks: 0,
            },
        });
        // Flush the microtask queue for the rejected promise.
        await vi.runOnlyPendingTimersAsync();
        const failCall = firstArgs(toastUpdate).find(
            (arg) => typeof arg.message === 'string' && arg.message.includes('Could not connect'),
        );
        expect(failCall).toBeDefined();
        expect(onRevert).toHaveBeenCalledTimes(1);
    });

    it('cancels and hides the toast if the user re-picks mid-connect', () => {
        setTarget();
        startConnectLifecycle({
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            onRevert: () => {},
            sessionId: 'sess-1',
            t,
            transfer: null,
        });
        // User clears + re-picks a different device while we're mid-connect.
        act(() => {
            useRemoteTargetStore.getState().actions.clearTarget();
        });
        expect(toastHide).toHaveBeenCalledWith(expect.stringContaining('dev-1'));
    });
});
