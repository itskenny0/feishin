import { describe, expect, it } from 'vitest';

import { computeSidebarItemActive } from './sidebar-item';

describe('computeSidebarItemActive', () => {
    it('matches the exact route', () => {
        expect(computeSidebarItemActive('/library/albums', '/library/albums')).toBe(true);
    });

    it('matches sub-routes via startsWith so detail pages highlight the parent', () => {
        expect(computeSidebarItemActive('/library/albums', '/library/albums/123')).toBe(true);
    });

    it('does not match unrelated routes', () => {
        expect(computeSidebarItemActive('/library/albums', '/library/artists')).toBe(false);
    });

    it('treats Home ("/") as exact-match only', () => {
        expect(computeSidebarItemActive('/', '/')).toBe(true);
        expect(computeSidebarItemActive('/', '/library/albums')).toBe(false);
    });

    it('accepts an object `to` and reads its pathname', () => {
        expect(computeSidebarItemActive({ pathname: '/library/albums' }, '/library/albums/1')).toBe(
            true,
        );
    });

    it('treats a missing pathname on an object `to` as empty (matches everything via startsWith)', () => {
        // An empty toPath startsWith-matches any pathname; this mirrors the
        // previous behavior where `to.pathname || ''` produced ''.
        expect(computeSidebarItemActive({ pathname: undefined }, '/anything')).toBe(true);
    });
});
