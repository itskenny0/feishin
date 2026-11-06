import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';

import { closeCacheDb, getActiveCacheDb, openCacheDb, setActiveCacheDb } from './db';

afterEach(async () => {
    await closeCacheDb('a', 'u');
    await closeCacheDb('b', 'u');
    await setActiveCacheDb(undefined, undefined);
});

describe('active cache db', () => {
    it('a slower superseded open does not steal the active db back', async () => {
        await openCacheDb('b', 'u'); // B's handle is cached, so reopening it is fast
        // Switch to A (a cold open), then straight back to B before A finishes.
        const slowA = openCacheDb('a', 'u');
        await openCacheDb('b', 'u');
        await slowA;
        expect(getActiveCacheDb()?.name).toBe('feishin-cache:b:u');
    });

    it('an open that a sign-out overtook does not resurrect the active db', async () => {
        const pending = openCacheDb('a', 'u');
        await setActiveCacheDb(undefined, undefined);
        await pending;
        expect(getActiveCacheDb()).toBeUndefined();
    });
});
