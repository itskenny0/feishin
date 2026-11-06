// The home hero carousel keeps its index when `data` changes. A random-sort
// refetch can return fewer unique albums with artwork than the index the user
// had paged to, which used to read `.id` of undefined and crash the page.

import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { SingleFeatureCarousel } from '/@/renderer/components/feature-carousel/single-feature-carousel';

vi.mock('/@/renderer/components/item-image/item-image', () => ({
    ItemImage: () => null,
    useItemImageRequest: () => undefined,
}));
vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ addToQueueByFetch: vi.fn() }),
}));
vi.mock('/@/renderer/features/shared/components/library-background-overlay', () => ({
    BackgroundOverlay: () => null,
}));
vi.mock('/@/renderer/features/shared/components/library-header', () => ({
    calculateTitleSize: () => 32,
}));
vi.mock('/@/renderer/features/shared/components/play-button-group', () => ({
    PlayButtonGroup: () => null,
}));
vi.mock('/@/renderer/hooks', () => ({
    useContainerQuery: () => ({ ref: vi.fn() }),
    useFastAverageColor: () => ({ background: undefined }),
}));
vi.mock('/@/renderer/store', () => ({ useCurrentServer: () => null }));
vi.mock('/@/renderer/store/settings.store', () => ({
    useShowFilesystemNameForAlbums: () => false,
}));
vi.mock('/@/shared/components/image/use-native-image', () => ({
    useNativeImage: () => ({ displaySrc: undefined }),
}));

const albums = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        albumArtists: [],
        genres: [],
        id: `al${i}`,
        name: `Album ${i}`,
        releaseYear: null,
    })) as never[];

const renderCarousel = (data: never[]) => (
    <MantineProvider>
        <MemoryRouter>
            <SingleFeatureCarousel data={data} />
        </MemoryRouter>
    </MantineProvider>
);

describe('SingleFeatureCarousel', () => {
    it('stays on a valid album when the data shrinks below the current index', () => {
        const { container, rerender } = render(renderCarousel(albums(3)));
        const next = container.querySelectorAll('button')[1];
        fireEvent.click(next);
        fireEvent.click(next);
        expect(screen.getByText('Album 2')).toBeInTheDocument();

        rerender(renderCarousel(albums(2)));
        expect(screen.getAllByText(/Album \d/).length).toBeGreaterThan(0);
    });
});
