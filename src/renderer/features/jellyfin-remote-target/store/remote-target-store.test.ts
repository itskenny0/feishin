import { describe, expect, it } from 'vitest';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

describe('remote-target-store reconcileSession', () => {
    it('updates sessionId without clearing mirrored now-playing', () => {
        const { actions } = useRemoteTargetStore.getState();
        actions.setTarget({
            capabilities: ['PlayPause'],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-A',
        });
        actions.setMirrored({
            nowPlayingItem: { id: 'song-1', name: 'Test' } as never,
        });

        actions.reconcileSession({
            capabilities: ['PlayPause', 'Seek'],
            deviceName: 'Living Room',
            sessionId: 'sess-B',
        });

        const state = useRemoteTargetStore.getState();
        expect(state.sessionId).toBe('sess-B');
        expect(state.mirrored.capabilities).toEqual(['PlayPause', 'Seek']);
        expect(state.mirrored.nowPlayingItem).toEqual({ id: 'song-1', name: 'Test' });
        expect(state.targetDeviceId).toBe('dev-1');

        actions.clearTarget();
    });
});
