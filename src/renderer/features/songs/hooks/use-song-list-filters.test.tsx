import { act, renderHook } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/renderer/store', () => ({ useCurrentServer: () => ({ id: 'server-1' }) }));

import { useSongListFilters } from '/@/renderer/features/songs/hooks/use-song-list-filters';

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

// The Navidrome song filter has a single "year" input that sets both bounds.
describe('useSongListFilters year range', () => {
    it('back-to-back setMinYear + setMaxYear keep only the second', async () => {
        const { result } = renderHook(() => useSongListFilters(), { wrapper });
        await act(async () => {
            result.current.setMinYear(1999);
            result.current.setMaxYear(1999);
        });
        expect(result.current.query.minYear).toBeUndefined();
        expect(result.current.query.maxYear).toBe(1999);
    });

    it('setYearRange sets both bounds', async () => {
        const { result } = renderHook(() => useSongListFilters(), { wrapper });
        await act(async () => result.current.setYearRange(1999, 1999));
        expect(result.current.query.minYear).toBe(1999);
        expect(result.current.query.maxYear).toBe(1999);

        await act(async () => result.current.setYearRange(null, null));
        expect(result.current.query.minYear).toBeUndefined();
        expect(result.current.query.maxYear).toBeUndefined();
    });
});
