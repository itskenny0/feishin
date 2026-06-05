import { Rating as MantineRating, RatingProps as MantineRatingProps } from '@mantine/core';
import clsx from 'clsx';
import debounce from 'lodash/debounce';
import { useCallback, useEffect, useMemo } from 'react';

import styles from './rating.module.css';

interface RatingProps extends MantineRatingProps {
    preventDefault?: boolean;
    stopPropagation?: boolean;
}

export const Rating = ({
    classNames,
    onChange,
    preventDefault = true,
    size,
    stopPropagation = true,
    style,
    ...props
}: RatingProps) => {
    const valueChange = useCallback(
        (rating: number) => {
            if (onChange) {
                if (rating === props.value) {
                    onChange(0);
                } else {
                    onChange(rating);
                }
            }
        },
        [onChange, props.value],
    );

    // Memoize the debounced wrapper so we don't allocate a fresh trailing-edge
    // debounce on every render (this Rating renders once per table row, so the
    // table-rating column was creating a new debounce per cell per re-render),
    // and flush/cancel it on unmount to avoid firing onChange after the row is
    // gone.
    const debouncedOnChange = useMemo(() => debounce(valueChange, 100), [valueChange]);

    useEffect(() => {
        return () => {
            debouncedOnChange.cancel();
        };
    }, [debouncedOnChange]);

    // Stable classNames identity (per size/classNames inputs) so Mantine's
    // internal symbol memoization isn't invalidated by a fresh object each
    // render. The redundant `style={{ ...style }}` spread is dropped for the
    // same reason — pass the caller's style through untouched.
    const mergedClassNames = useMemo(
        () => ({
            root: clsx(styles.root, {
                [styles.lg]: size === 'lg',
                [styles.md]: size === 'md',
                [styles.sm]: size === 'sm',
                [styles.xl]: size === 'xl',
                [styles.xs]: size === 'xs',
            }),
            symbolBody: styles.symbolBody,
            ...classNames,
        }),
        [size, classNames],
    );

    return (
        <MantineRating
            classNames={mergedClassNames}
            style={style}
            {...props}
            onChange={(e) => {
                debouncedOnChange(e);
            }}
            onClick={(e) => {
                if (preventDefault) {
                    e.preventDefault();
                }
                if (stopPropagation) {
                    e.stopPropagation();
                }
            }}
        />
    );
};
