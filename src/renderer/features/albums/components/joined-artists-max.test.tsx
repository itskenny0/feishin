// Card subtitles for big compilations: a 50-artist album must not render
// 50 names (device screenshot: the home card's artist list blew up the
// whole page). `maxArtists` caps the rendered names with a "+N" suffix.

import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { JoinedArtists } from '/@/renderer/features/albums/components/joined-artists';

const artists = Array.from({ length: 50 }, (_, i) => ({
    id: `a${i + 1}`,
    name: `Artist ${i + 1}`,
}));
const artistName = artists.map((a) => a.name).join(', ');

const renderJoined = (max?: number) =>
    render(
        <MantineProvider>
            <MemoryRouter>
                <JoinedArtists artistName={artistName} artists={artists} maxArtists={max} />
            </MemoryRouter>
        </MantineProvider>,
    );

describe('JoinedArtists maxArtists', () => {
    it('caps rendered artists and appends a +N suffix', () => {
        renderJoined(4);
        expect(screen.getByText('Artist 1')).toBeInTheDocument();
        expect(screen.getByText('Artist 4')).toBeInTheDocument();
        expect(screen.queryByText('Artist 5')).not.toBeInTheDocument();
        expect(screen.getByText(/\+46/)).toBeInTheDocument();
    });

    it('renders everything when under the cap', () => {
        render(
            <MantineProvider>
                <MemoryRouter>
                    <JoinedArtists
                        artistName="Artist 1, Artist 2"
                        artists={artists.slice(0, 2)}
                        maxArtists={4}
                    />
                </MemoryRouter>
            </MantineProvider>,
        );
        expect(screen.getByText('Artist 1')).toBeInTheDocument();
        expect(screen.getByText('Artist 2')).toBeInTheDocument();
        expect(screen.queryByText(/\+/)).not.toBeInTheDocument();
    });

    it('without maxArtists the behavior is unchanged (all names render)', () => {
        renderJoined(undefined);
        expect(screen.getByText('Artist 1')).toBeInTheDocument();
        expect(screen.getByText('Artist 50')).toBeInTheDocument();
    });
});
