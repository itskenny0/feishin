import { MantineProvider } from '@mantine/core';
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

import { LibraryItem } from '/@/shared/types/domain-types';

const TEST_URL = 'https://music.example/Items/abc/Images/Primary?width=80';

// Mock the renderer api so getImageRequest returns a deterministic request
// (no real server / controller registry needed).
vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getImageRequest: vi.fn(({ query }: { query: { id: string; size?: number } }) => ({
                cacheKey: TEST_URL,
                headers: { Authorization: 'MediaBrowser Token="x"' },
                url: `${TEST_URL}&id=${query.id}&size=${query.size ?? 0}`,
            })),
        },
    },
}));

// Mock the store: ItemImage only needs these selectors + a value-shaped
// GeneralSettingsSchema (the component reads `z.infer<...>['imageRes']` as a
// type; the runtime value is erased, but the import must resolve).
vi.mock('/@/renderer/store', () => ({
    GeneralSettingsSchema: z.object({
        imageRes: z.object({
            fullScreenPlayer: z.number(),
            header: z.number(),
            itemCard: z.number(),
            sidebar: z.number(),
            table: z.number(),
        }),
    }),
    getServerById: () => undefined,
    useAuthStore: { getState: () => ({ currentServer: { id: 'srv' } }) },
    useBlurExplicitImages: () => false,
    useCurrentServerId: () => 'srv',
    useImageRes: () => ({
        fullScreenPlayer: 1024,
        header: 300,
        itemCard: 300,
        sidebar: 400,
        table: 80,
    }),
    useSettingsStore: { getState: () => ({ general: { imageRes: {} } }) },
}));

import { ItemImage, useItemImageRequest } from '/@/renderer/components/item-image/item-image';
import { registerThumbnailResolver } from '/@/shared/components/image/use-native-image';

type ResolverCall = { itemId: string; variant: string };
let resolverCalls: ResolverCall[];

beforeEach(() => {
    resolverCalls = [];
    // Register a spy resolver. The hook prefers the shared refcounted cache
    // when registered; this test imports neither cache/images.ts nor
    // lifecycle.ts, so the shared cache stays null and the per-call resolver
    // path is exercised. Return the same URL so the hook treats it as a miss
    // and the test never has to mint a real blob.
    registerThumbnailResolver((itemId, variant, request) => {
        resolverCalls.push({ itemId, variant });
        return Promise.resolve(typeof request === 'string' ? request : request.url);
    });
});

afterEach(() => {
    cleanup();
    registerThumbnailResolver(null);
    vi.clearAllMocks();
});

// The surface bucket selected per `type`, read off the request the hook
// builds. `useItemImageRequest` is the source of truth the resolver wiring
// reads `variant` from, so assert the mapping here (covers the size-less
// `fullScreenPlayer`/missing-type cases the render path can't surface).
describe('useItemImageRequest → variant mapping', () => {
    const variantFor = (type?: string): string | undefined => {
        const { result } = renderHook(() =>
            useItemImageRequest({ id: 'abc', itemType: LibraryItem.ALBUM, type: type as never }),
        );
        return result.current?.variant;
    };

    it('maps table → table', () => expect(variantFor('table')).toBe('table'));
    it('maps itemCard → itemCard', () => expect(variantFor('itemCard')).toBe('itemCard'));
    it('maps sidebar → sidebar', () => expect(variantFor('sidebar')).toBe('sidebar'));
    it('maps header → header', () => expect(variantFor('header')).toBe('header'));
    it('maps fullScreenPlayer → fullScreen', () =>
        expect(variantFor('fullScreenPlayer')).toBe('fullScreen'));
    it('defaults a missing type → fullScreen', () =>
        expect(variantFor(undefined)).toBe('fullScreen'));
});

describe('ItemImage → thumbnail resolver (end-to-end variant)', () => {
    const renderItemImage = (type: string) =>
        render(
            <MantineProvider>
                <ItemImage
                    enableViewport={false}
                    id="abc"
                    itemType={LibraryItem.ALBUM}
                    type={type as never}
                />
            </MantineProvider>,
        );

    const lastVariant = async (): Promise<string> => {
        await waitFor(() => expect(resolverCalls.length).toBeGreaterThan(0));
        return resolverCalls[resolverCalls.length - 1].variant;
    };

    it('hands the table surface to the resolver as variant "table"', async () => {
        renderItemImage('table');
        expect(await lastVariant()).toBe('table');
    });

    it('hands the itemCard surface to the resolver as variant "itemCard"', async () => {
        renderItemImage('itemCard');
        expect(await lastVariant()).toBe('itemCard');
    });
});
