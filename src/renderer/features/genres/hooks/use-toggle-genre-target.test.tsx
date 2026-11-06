import { act, renderHook } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

const setGenreBehavior = vi.fn();
vi.mock('/@/renderer/store', () => ({
    GenreTarget: { ALBUM: 'album', TRACK: 'track' },
    useCurrentServer: () => ({ id: 'server-1' }),
    useGenreTarget: () => 'album',
    useSettingsStoreActions: () => ({ setGenreBehavior }),
}));

import { useToggleGenreTarget } from '/@/renderer/features/genres/hooks/use-toggle-genre-target';

const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter
        initialEntries={['/?compilation=true&isRecentlyPlayed=true&minYear=1999&searchTerm=x']}
    >
        {children}
    </MemoryRouter>
);

describe('useToggleGenreTarget', () => {
    it('clears album-only AND shared filter keys in one update', async () => {
        const { result } = renderHook(
            () => ({ params: useSearchParams()[0], toggle: useToggleGenreTarget() }),
            { wrapper },
        );

        await act(async () => result.current.toggle());

        expect([...result.current.params.keys()]).toEqual([]);
        expect(setGenreBehavior).toHaveBeenCalledWith('track');
    });
});
