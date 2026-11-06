import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Pagination } from '/@/shared/components/pagination/pagination';

// jsdom has no layout, so force the wide (isSm) container branch.
vi.mock('/@/shared/hooks/use-container-query', () => ({
    useContainerQuery: () => ({ isMd: true, isSm: true, isXl: false, ref: () => {} }),
}));

const renderPagination = (value: number, totalItemCount: number, onChange = vi.fn()) => (
    <MantineProvider>
        <Pagination
            itemsPerPage={10}
            onChange={onChange}
            total={10}
            totalItemCount={totalItemCount}
            value={value}
        />
    </MantineProvider>
);

describe('Pagination', () => {
    it('does not render a stray "0" for an empty list', () => {
        render(renderPagination(0, 0));
        expect(screen.queryByText('0')).toBeNull();
    });

    it('go-to-page starts from the CURRENT page, not the page at mount', async () => {
        const onChange = vi.fn();
        const { rerender } = render(renderPagination(0, 100, onChange));
        rerender(renderPagination(4, 100, onChange)); // now on page 5

        const buttons = screen.getAllByRole('button');
        fireEvent.click(buttons[buttons.length - 1]); // the "..." go-to trigger
        const input = await screen.findByRole('textbox');
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).toHaveBeenLastCalledWith(4);
    });
});
