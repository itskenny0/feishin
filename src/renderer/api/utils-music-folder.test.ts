// Pure-function tests for mergeMusicFolderId. These pin the "inject the server's
// configured music folder into a query when the query doesn't already specify
// one" behaviour, including the single-vs-array collapse and the guard cases
// where the original query must be returned untouched.

import { describe, expect, it } from 'vitest';

import { mergeMusicFolderId } from '/@/renderer/api/utils-music-folder';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

const server = (
    overrides: Partial<ServerListItemWithCredential> = {},
): ServerListItemWithCredential =>
    ({
        credential: 'cred',
        id: 'srv1',
        name: 'Test',
        type: ServerType.JELLYFIN,
        url: 'http://localhost',
        userId: null,
        username: 'tester',
        ...overrides,
    }) as ServerListItemWithCredential;

describe('mergeMusicFolderId', () => {
    it('returns the query unchanged when server is null', () => {
        const query: { foo: string; musicFolderId?: string | string[] } = { foo: 'bar' };
        expect(mergeMusicFolderId(query, null)).toBe(query);
    });

    it('returns the query unchanged when the server has no musicFolderId', () => {
        const query: { foo: string; musicFolderId?: string | string[] } = { foo: 'bar' };
        expect(mergeMusicFolderId(query, server())).toBe(query);
    });

    it('returns the query unchanged when the server musicFolderId is empty', () => {
        const query: { foo: string; musicFolderId?: string | string[] } = { foo: 'bar' };
        expect(mergeMusicFolderId(query, server({ musicFolderId: [] }))).toBe(query);
    });

    it('returns the query unchanged when the query already specifies a musicFolderId', () => {
        const query = { musicFolderId: 'already-set' };
        expect(mergeMusicFolderId(query, server({ musicFolderId: ['a', 'b'] }))).toBe(query);
    });

    it('collapses a single-entry server folder list to a scalar', () => {
        const query: { foo: string; musicFolderId?: string | string[] } = { foo: 'bar' };
        const result = mergeMusicFolderId(query, server({ musicFolderId: ['only'] }));
        expect(result).toEqual({ foo: 'bar', musicFolderId: 'only' });
        // original query is not mutated
        expect(query).toEqual({ foo: 'bar' });
    });

    it('keeps a multi-entry server folder list as an array', () => {
        const query: { foo: string; musicFolderId?: string | string[] } = { foo: 'bar' };
        const result = mergeMusicFolderId(query, server({ musicFolderId: ['a', 'b'] }));
        expect(result).toEqual({ foo: 'bar', musicFolderId: ['a', 'b'] });
    });
});
