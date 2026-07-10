import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { LibraryCacheDb } from './db';
import { LocalMediaStore } from './media-store';

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`sourcetag-test-${(seq += 1)}`);
    await db.open();
    return { db, store: new LocalMediaStore(() => db) };
};

describe('LocalMediaStore SourceTag', () => {
    let ctx: Awaited<ReturnType<typeof makeStore>>;
    beforeEach(async () => {
        ctx = await makeStore();
        await ctx.db.mediaBlobs.clear();
    });

    it('persists SourceTag on a new blob', async () => {
        await ctx.store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:album:a1',
            serverId: 's',
            songId: 'song1',
            sourceTag: { container: 'flac', size: 10, updatedAt: '2026-01-01' },
        });
        const row = await ctx.store.get('s', 'song1');
        expect(row?.SourceTag).toEqual({ container: 'flac', size: 10, updatedAt: '2026-01-01' });
    });

    it('does not overwrite SourceTag on a dedup membership hit', async () => {
        await ctx.store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:album:a1',
            serverId: 's',
            songId: 'song1',
            sourceTag: { size: 10 },
        });
        const isNew = await ctx.store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:playlist:p1',
            serverId: 's',
            songId: 'song1',
            sourceTag: { size: 999 },
        });
        expect(isNew).toBe(false);
        const row = await ctx.store.get('s', 'song1');
        expect(row?.SourceTag).toEqual({ size: 10 });
        expect(row?.EntityKeys).toContain('s:playlist:p1');
    });
});
