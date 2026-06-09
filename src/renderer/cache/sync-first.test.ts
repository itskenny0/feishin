// Sync-first policy — regression suite.
//
// Proves the three contractual behaviours of the sync-first migration:
//  (a) NO background revalidate fires after a cache hit while sync-first
//      applies (localCache.enabled + cacheAvailable) — the sweep is the
//      only thing talking to the server for library data;
//  (b) the revalidate / network path DOES fire when the cache is disabled
//      or cannot answer (fromCache → undefined keeps the network fallback);
//  (c) an explicit refresh (prepareExplicitRefresh) re-opens the network
//      window so a deliberate user action always reaches the server.

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { localCache: { enabled: undefined as boolean | undefined } },
}));

vi.mock('/@/renderer/store/settings.store', () => ({
    useSettingsStore: {
        getState: () => mocks.settings,
    },
}));

const FAKE_DB = { table: () => ({}) } as unknown as LibraryCacheDb;
vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => FAKE_DB,
}));

import { cachedSwr } from '/@/renderer/cache/hooks';
import { useCacheStore } from '/@/renderer/cache/store';
import {
    consumeRevalidateThrottle,
    entityForLibraryItem,
    entityForListKey,
    isSyncFirstActive,
    prepareExplicitRefresh,
    resetSyncFirstStateForTests,
    shouldRevalidateFromNetwork,
} from '/@/renderer/cache/sync-first';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

const makeCtx = (queryKey: QueryKey): QueryFunctionContext =>
    ({ queryKey, signal: new AbortController().signal }) as unknown as QueryFunctionContext;

const flushAsync = async (): Promise<void> => {
    // Two macrotask hops so the fire-and-forget revalidate IIFE (await
    // remote → writeSnapshot/setQueryData) has fully settled either way.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
};

const enableSyncFirst = (): void => {
    mocks.settings.localCache.enabled = true;
    useCacheStore.setState((s) => ({ ...s, cacheAvailable: true }) as never);
};

afterEach(() => {
    vi.useRealTimers();
    resetSyncFirstStateForTests();
    mocks.settings.localCache.enabled = undefined;
    useCacheStore.setState((s) => ({ ...s, cacheAvailable: undefined }) as never);
});

describe('shouldRevalidateFromNetwork — policy predicate', () => {
    it('suppresses revalidation when localCache.enabled and the cache is up', () => {
        enableSyncFirst();
        expect(isSyncFirstActive()).toBe(true);
        expect(shouldRevalidateFromNetwork()).toBe(false);
    });

    it('allows revalidation when the cache is disabled in settings', () => {
        mocks.settings.localCache.enabled = false;
        useCacheStore.setState((s) => ({ ...s, cacheAvailable: true }) as never);
        expect(shouldRevalidateFromNetwork()).toBe(true);
    });

    it('allows revalidation when the cache subsystem is cold/unavailable', () => {
        mocks.settings.localCache.enabled = true;
        useCacheStore.setState((s) => ({ ...s, cacheAvailable: false }) as never);
        expect(shouldRevalidateFromNetwork()).toBe(true);
    });

    it('re-opens the network path during the explicit-refresh window, then closes it', () => {
        vi.useFakeTimers();
        enableSyncFirst();
        expect(shouldRevalidateFromNetwork()).toBe(false);

        prepareExplicitRefresh('albums');
        expect(shouldRevalidateFromNetwork()).toBe(true);

        // Window expires → sync-first re-engages.
        vi.setSystemTime(Date.now() + 16_000);
        expect(shouldRevalidateFromNetwork()).toBe(false);
    });
});

describe('cachedSwr under sync-first', () => {
    it('(a) does NOT fire a background revalidate after a cache hit', async () => {
        enableSyncFirst();
        const queryKey: QueryKey = ['srv', 'albums', 'list', Math.random()];
        const cachedValue = { items: [{ id: 'cached' }] };
        const fromCache = vi.fn(async () => cachedValue);
        const remote = vi.fn(async () => ({ items: [{ id: 'network' }] }));

        const result = await cachedSwr({ ctx: makeCtx(queryKey), fromCache, queryKey, remote });
        await flushAsync();

        expect(result).toEqual(cachedValue);
        expect(remote).not.toHaveBeenCalled();
    });

    it('(b) fires the background revalidate after a cache hit when the cache is disabled', async () => {
        mocks.settings.localCache.enabled = false;
        useCacheStore.setState((s) => ({ ...s, cacheAvailable: true }) as never);

        const queryKey: QueryKey = ['srv', 'albums', 'list', Math.random()];
        const cachedValue = { items: [{ id: 'cached' }] };
        const fromCache = vi.fn(async () => cachedValue);
        const remote = vi.fn(async () => ({ items: [{ id: 'network' }] }));

        const result = await cachedSwr({ ctx: makeCtx(queryKey), fromCache, queryKey, remote });
        await flushAsync();

        // Cached value is still what's served (SWR contract) …
        expect(result).toEqual(cachedValue);
        // … but the background revalidate reached the server.
        expect(remote).toHaveBeenCalledTimes(1);
    });

    it('(b) still falls through to the network when fromCache returns undefined under sync-first', async () => {
        enableSyncFirst();
        const queryKey: QueryKey = ['srv', 'albums', 'list', Math.random()];
        const networkValue = { items: [{ id: 'network' }] };
        const fromCache = vi.fn(async () => undefined);
        const remote = vi.fn(async () => networkValue);

        const result = await cachedSwr({ ctx: makeCtx(queryKey), fromCache, queryKey, remote });

        expect(result).toEqual(networkValue);
        expect(remote).toHaveBeenCalledTimes(1);
    });

    it('(c) explicit refresh forces the network path even on a cache hit', async () => {
        enableSyncFirst();
        prepareExplicitRefresh('albums');

        const queryKey: QueryKey = ['srv', 'albums', 'list', Math.random()];
        const cachedValue = { items: [{ id: 'cached' }] };
        const fromCache = vi.fn(async () => cachedValue);
        const remote = vi.fn(async () => ({ items: [{ id: 'network' }] }));

        const result = await cachedSwr({ ctx: makeCtx(queryKey), fromCache, queryKey, remote });
        await flushAsync();

        expect(result).toEqual(cachedValue);
        expect(remote).toHaveBeenCalledTimes(1);
    });
});

describe('revalidate throttle + explicit refresh', () => {
    it('throttles repeat revalidates for the same queryKey within the TTL', () => {
        const queryKey: QueryKey = ['srv', 'albums', 'list', Math.random()];
        expect(consumeRevalidateThrottle(queryKey)).toBe(true);
        expect(consumeRevalidateThrottle(queryKey)).toBe(false);
    });

    it('prepareExplicitRefresh clears the throttle so a manual refresh is never swallowed', () => {
        const queryKey: QueryKey = ['srv', 'albums', 'list', Math.random()];
        expect(consumeRevalidateThrottle(queryKey)).toBe(true);
        expect(consumeRevalidateThrottle(queryKey)).toBe(false);

        prepareExplicitRefresh('albums');
        expect(consumeRevalidateThrottle(queryKey)).toBe(true);
    });
});

describe('entity mapping helpers', () => {
    it('maps LibraryItem list surfaces onto cache entities', () => {
        expect(entityForLibraryItem(LibraryItem.ALBUM)).toBe('albums');
        expect(entityForLibraryItem(LibraryItem.ALBUM_ARTIST)).toBe('albumArtists');
        expect(entityForLibraryItem(LibraryItem.SONG)).toBe('songs');
        expect(entityForLibraryItem(LibraryItem.PLAYLIST)).toBe('playlists');
        expect(entityForLibraryItem(LibraryItem.GENRE)).toBe('genres');
    });

    it('maps ItemListKey sub-lists onto the entity whose rows they render', () => {
        expect(entityForListKey(ItemListKey.ALBUM_ARTIST_ALBUM)).toBe('albums');
        expect(entityForListKey(ItemListKey.PLAYLIST_SONG)).toBe('songs');
        expect(entityForListKey(ItemListKey.RADIO)).toBeUndefined();
    });
});
