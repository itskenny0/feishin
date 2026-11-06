import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentTitle } from '/@/renderer/features/shared/hooks/use-document-title';
import { PlayerStatus } from '/@/shared/types/types';

const state = vi.hoisted(() => ({ trackInfo: true }));

vi.mock('/@/renderer/store/player.store', () => ({
    usePlayerSong: () => ({ artistName: 'Artist', name: 'Song' }),
    usePlayerStatus: () => 'playing' as PlayerStatus,
}));
vi.mock('/@/renderer/store/settings.store', () => ({
    useWindowBarTrackinfo: () => state.trackInfo,
}));

describe('useDocumentTitle', () => {
    beforeEach(() => {
        document.title = '';
    });

    it('shows the playing track', () => {
        state.trackInfo = true;
        renderHook(() => useDocumentTitle());
        expect(document.title).toContain('Song');
    });

    it('keeps track info out of the title when the window title setting is off', () => {
        state.trackInfo = false;
        renderHook(() => useDocumentTitle());
        expect(document.title).toBe('Feishin');
    });
});
