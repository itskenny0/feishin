import { Fragment, ReactNode, useEffect } from 'react';

import styles from './item-list-pagination.module.css';

import { Pagination } from '/@/shared/components/pagination/pagination';

interface ItemListWithPaginationProps {
    children: ReactNode;
    currentPage: number;
    itemsPerPage: number;
    onChange: (e: number) => void;
    pageCount: number;
    totalItemCount: number;
}

export const ItemListWithPagination = ({
    children,
    currentPage,
    itemsPerPage,
    onChange,
    pageCount,
    totalItemCount,
}: ItemListWithPaginationProps) => {
    // The page param survives search / filter changes; when the results shrink
    // below the current page, move back to the last page instead of an empty one.
    useEffect(() => {
        if (pageCount > 0 && currentPage > pageCount - 1) {
            onChange(pageCount - 1);
        }
    }, [currentPage, onChange, pageCount]);

    return (
        <div className={styles.container}>
            <Fragment key={currentPage}>{children}</Fragment>
            <div className={styles.paginationContainer}>
                <Pagination
                    itemsPerPage={itemsPerPage}
                    onChange={onChange}
                    total={pageCount}
                    totalItemCount={totalItemCount}
                    value={currentPage}
                />
            </div>
        </div>
    );
};
