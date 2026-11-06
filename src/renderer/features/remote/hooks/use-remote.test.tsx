import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { listeners, player } = vi.hoisted(() => {
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const on = (channel: string) => (cb: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), cb]);
    };
    (globalThis as any).window.api = {
        ipc: {
            removeAllListeners: (channel: string) => listeners.delete(channel),
            send: () => {},
        },
        remote: {
            requestFavorite: on('request-favorite'),
            requestPosition: on('request-position'),
            requestRating: on('request-rating'),
            requestSeek: on('request-seek'),
            requestVolume: on('request-volume'),
            updateSetting: async () => {},
            updateSong: () => {},
        },
    };
    const player = { mediaSeekToTimestamp: vi.fn(), mediaSkipForward: vi.fn(), setVolume: vi.fn() };
    return { listeners, player };
});

vi.mock('is-electron', () => ({ default: () => true }));
vi.mock('/@/renderer/features/remote/hooks/use-remote-push', () => ({ useRemotePush: () => {} }));
vi.mock('/@/renderer/features/shared/hooks/use-set-rating', () => ({
    useSetRating: () => vi.fn(),
}));
vi.mock('/@/renderer/features/shared/mutations/create-favorite-mutation', () => ({
    useCreateFavorite: () => ({}),
}));
vi.mock('/@/renderer/features/shared/mutations/delete-favorite-mutation', () => ({
    useDeleteFavorite: () => ({}),
}));
vi.mock('/@/renderer/store', () => ({
    usePlayerActions: () => player,
    useRemoteSettings: () => ({ enabled: true, password: '', port: 4333, username: '' }),
}));
vi.mock('/@/renderer/store/player.store', () => ({
    usePlayerStoreBase: { getState: () => ({ getCurrentSong: () => undefined }) },
}));

import { RemoteHook } from './use-remote';

describe('useRemote', () => {
    it('leaves request-seek to MPRIS so one Seek skips once', () => {
        // The remote server never emits request-seek; only MPRIS does, and
        // use-mpris already applies it. A second handler doubled every skip.
        const mprisSkip = vi.fn();
        listeners.set('request-seek', [(d) => mprisSkip((d as { offset: number }).offset)]);
        render(<RemoteHook />);

        listeners.get('request-seek')?.forEach((cb) => cb({ offset: 10 }));
        expect(mprisSkip).toHaveBeenCalledTimes(1);
        expect(player.mediaSkipForward).not.toHaveBeenCalled();

        listeners.get('request-position')?.forEach((cb) => cb({ position: 42 }));
        expect(player.mediaSeekToTimestamp).toHaveBeenCalledWith(42);
    });
});
