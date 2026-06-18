// Unit tests for the offline-availability selectors. We mock the cache store
// with an in-memory availability slice and assert the song-level and
// entity-level membership checks (including the song-entity special case and
// the undefined-arg short-circuits).

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        offlineAvailability: {
            entityKeys: new Set<string>(['srv:album:al1', 'srv:playlist:pl1']),
            songKeys: new Set<string>(['srv:s1', 'srv:s2']),
        },
        volumeAvailable: true,
    },
}));

vi.mock('/@/renderer/cache/store', () => ({
    useCacheStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
}));

import {
    useIsEntityOfflineAvailable,
    useIsSongOfflineAvailable,
} from '/@/renderer/cache/use-offline-availability';

describe('useIsSongOfflineAvailable', () => {
    it('is true for a downloaded song', () => {
        const { result } = renderHook(() => useIsSongOfflineAvailable('srv', 's1'));
        expect(result.current).toBe(true);
    });

    it('is false for a song that is not downloaded', () => {
        const { result } = renderHook(() => useIsSongOfflineAvailable('srv', 'nope'));
        expect(result.current).toBe(false);
    });

    it('short-circuits to false when serverId/songId is missing', () => {
        const { result: a } = renderHook(() => useIsSongOfflineAvailable(undefined, 's1'));
        const { result: b } = renderHook(() => useIsSongOfflineAvailable('srv', undefined));
        expect(a.current).toBe(false);
        expect(b.current).toBe(false);
    });

    it('is false when the storage volume is unavailable (SD card removed)', () => {
        mocks.state.volumeAvailable = false;
        const { result } = renderHook(() => useIsSongOfflineAvailable('srv', 's1'));
        expect(result.current).toBe(false);
        mocks.state.volumeAvailable = true;
    });
});

describe('useIsEntityOfflineAvailable', () => {
    it('is true for a target entity with downloaded songs', () => {
        const { result } = renderHook(() => useIsEntityOfflineAvailable('srv', 'album', 'al1'));
        expect(result.current).toBe(true);
    });

    it('is false for an entity with nothing downloaded', () => {
        const { result } = renderHook(() => useIsEntityOfflineAvailable('srv', 'album', 'al2'));
        expect(result.current).toBe(false);
    });

    it('checks the song key (not an entity key) for a song entity', () => {
        const { result: hit } = renderHook(() => useIsEntityOfflineAvailable('srv', 'song', 's2'));
        const { result: miss } = renderHook(() => useIsEntityOfflineAvailable('srv', 'song', 's9'));
        expect(hit.current).toBe(true);
        expect(miss.current).toBe(false);
    });

    it('short-circuits to false on missing args', () => {
        const { result } = renderHook(() => useIsEntityOfflineAvailable(undefined, 'album', 'al1'));
        expect(result.current).toBe(false);
    });
});
