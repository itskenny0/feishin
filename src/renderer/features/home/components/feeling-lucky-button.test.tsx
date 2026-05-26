import type { CachedSong } from '/@/renderer/cache/types';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so these are initialized before the hoisted vi.mock factories run.
const { addToQueueByData, fetchQuery, getActiveCacheDb } = vi.hoisted(() => ({
    addToQueueByData: vi.fn(),
    fetchQuery: vi.fn(),
    getActiveCacheDb: vi.fn(),
}));

// Fake Dexie db whose songs table the real pickRandomFromCache can read.
const fakeDb = (rows: CachedSong[]) => ({
    songs: {
        bulkGet: async (ids: string[]) => ids.map((id) => rows.find((r) => r.Id === id)),
        toCollection: () => ({ primaryKeys: async () => rows.map((r) => r.Id) }),
    },
});
const cachedRow = (id: string): CachedSong =>
    ({ Id: id, Payload: { id, name: id } }) as unknown as CachedSong;

vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ addToQueueByData }),
}));
vi.mock('/@/renderer/store', () => ({ useCurrentServer: () => ({ id: 'srv1' }) }));
vi.mock('/@/renderer/lib/react-query', () => ({ queryClient: { fetchQuery } }));
vi.mock('/@/renderer/features/songs/api/songs-api', () => ({
    songsQueries: { random: (args: unknown) => args },
}));
vi.mock('/@/renderer/cache/db', () => ({ getActiveCacheDb }));
vi.mock('/@/renderer/cache/store', () => ({
    useCacheStore: { getState: () => ({ cacheAvailable: true }) },
}));
vi.mock('/@/renderer/hooks/use-haptic', () => ({ triggerHaptic: vi.fn() }));
vi.mock('/@/shared/components/icon/icon', () => ({ Icon: () => <span data-testid="icon" /> }));
vi.mock('/@/shared/components/toast/toast', () => ({
    toast: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

// Imported after mocks are registered.
import { FeelingLuckyButton } from '/@/renderer/features/home/components/feeling-lucky-button';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    addToQueueByData.mockClear();
    fetchQuery.mockReset();
    getActiveCacheDb.mockReset();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('FeelingLuckyButton gestures', () => {
    it('left-click plays from the local cache without touching the network', async () => {
        getActiveCacheDb.mockReturnValue(fakeDb([cachedRow('a'), cachedRow('b')]));

        render(<FeelingLuckyButton />);
        fireEvent.click(screen.getByRole('button'));
        await flush();

        expect(addToQueueByData).toHaveBeenCalledTimes(1);
        expect(addToQueueByData.mock.calls[0][0].map((s: { id: string }) => s.id).sort()).toEqual([
            'a',
            'b',
        ]);
        expect(fetchQuery).not.toHaveBeenCalled();
    });

    it('left-click falls back to remote when the cache is empty', async () => {
        getActiveCacheDb.mockReturnValue(fakeDb([]));
        fetchQuery.mockResolvedValue({ items: [{ id: 'r1' }] });

        render(<FeelingLuckyButton />);
        fireEvent.click(screen.getByRole('button'));
        await flush();
        await flush();

        expect(fetchQuery).toHaveBeenCalled();
        expect(addToQueueByData).toHaveBeenCalled();
    });

    it('right-click fetches a fresh remote set', async () => {
        getActiveCacheDb.mockReturnValue(fakeDb([cachedRow('a')]));
        fetchQuery.mockResolvedValue({ items: [{ id: 'r1' }] });

        render(<FeelingLuckyButton />);
        fireEvent.contextMenu(screen.getByRole('button'));
        await flush();
        await flush();

        expect(fetchQuery).toHaveBeenCalled();
        expect(getActiveCacheDb).not.toHaveBeenCalled();
    });

    it('touch long-press fetches remote and the trailing click is suppressed', async () => {
        vi.useFakeTimers();
        getActiveCacheDb.mockReturnValue(fakeDb([cachedRow('a')]));
        fetchQuery.mockResolvedValue({ items: [{ id: 'r1' }] });

        render(<FeelingLuckyButton />);
        const button = screen.getByRole('button');

        fireEvent.pointerDown(button, { clientX: 0, clientY: 0, pointerType: 'touch' });
        await vi.advanceTimersByTimeAsync(600); // long-press timer (500ms) fires
        fireEvent.pointerUp(button, { clientX: 0, clientY: 0, pointerType: 'touch' });
        fireEvent.click(button); // synthetic post-press click — must be swallowed
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchQuery).toHaveBeenCalled(); // remote path ran
        expect(getActiveCacheDb).not.toHaveBeenCalled(); // cache path was NOT triggered
    });
});
