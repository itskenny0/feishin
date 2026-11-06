// The `currentPage` URL param survives a search / filter change, so a
// filter that shrinks the results can leave the list past its last page
// (an empty page and "page 6 of 1"). The wrapper must move back into range.

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ItemListWithPagination } from '/@/renderer/components/item-list/item-list-pagination/item-list-pagination';

vi.mock('/@/shared/components/pagination/pagination', () => ({ Pagination: () => null }));

const renderPagination = (currentPage: number, pageCount: number) => {
    const onChange = vi.fn();
    render(
        <ItemListWithPagination
            currentPage={currentPage}
            itemsPerPage={50}
            onChange={onChange}
            pageCount={pageCount}
            totalItemCount={pageCount * 50}
        >
            <div />
        </ItemListWithPagination>,
    );
    return onChange;
};

describe('ItemListWithPagination', () => {
    it('moves back to the last page when the current page is past the end', () => {
        expect(renderPagination(5, 1)).toHaveBeenCalledWith(0);
        expect(renderPagination(5, 3)).toHaveBeenCalledWith(2);
    });

    it('leaves an in-range page (and an empty result) alone', () => {
        expect(renderPagination(2, 3)).not.toHaveBeenCalled();
        expect(renderPagination(0, 0)).not.toHaveBeenCalled();
    });
});
