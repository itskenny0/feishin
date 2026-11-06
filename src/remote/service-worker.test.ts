import { describe, expect, it, vi } from 'vitest';

describe('remote service worker fetch handler', () => {
    it('serves only the app shell through the cache; credentials and artwork bypass it', async () => {
        const handlers: Record<string, (e: unknown) => void> = {};
        vi.spyOn(self, 'addEventListener').mockImplementation(((type: string, h: any) => {
            handlers[type] = h;
        }) as never);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ clone: () => ({}) })),
        );
        vi.stubGlobal('caches', { open: async () => ({ put: async () => {} }) });
        await import('./service-worker');

        const responses: Promise<unknown>[] = [];
        const handled = (url: string) => {
            const respondWith = vi.fn((p: Promise<unknown>) => responses.push(p));
            handlers.fetch({ request: { method: 'GET', url }, respondWith });
            return respondWith.mock.calls.length > 0;
        };
        const origin = location.origin;

        expect(handled(`${origin}/`)).toBe(true);
        expect(handled(`${origin}/remote.js`)).toBe(true);
        expect(handled(`${origin}/credentials`)).toBe(false);
        expect(handled('https://jellyfin.example/Items/1/Images/Primary')).toBe(false);

        await Promise.all(responses);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
});
