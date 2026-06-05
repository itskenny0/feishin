import { useMemo } from 'react';

import { useElementSize } from '/@/shared/hooks/use-element-size';

interface UseContainerQueryProps {
    '2xl'?: number;
    '3xl'?: number;
    '4xl'?: number;
    '5xl'?: number;
    lg?: number;
    md?: number;
    sm?: number;
    xl?: number;
    xs?: number;
}

export const useContainerQuery = (props?: UseContainerQueryProps) => {
    const {
        '2xl': xxl,
        '3xl': xxxl,
        '4xl': xxxxl,
        '5xl': xxxxxl,
        lg,
        md,
        sm,
        xl,
        xs,
    } = props || {};
    const { height, ref, width } = useElementSize();

    const isXs = width >= (xs || 360);
    const isSm = width >= (sm || 480);
    const isMd = width >= (md || 600);
    const isLg = width >= (lg || 768);
    const isXl = width >= (xl || 960);
    const is2xl = width >= (xxl || 1152);
    const is3xl = width >= (xxxl || 1280);
    const is4xl = width >= (xxxxl || 1440);
    const is5xl = width >= (xxxxxl || 1600);

    const isCalculated = width !== 0;

    return {
        height,
        is2xl,
        is3xl,
        is4xl,
        is5xl,
        isCalculated,
        isLg,
        isMd,
        isSm,
        isXl,
        isXs,
        ref,
        width,
    };
};

export type ContainerQueryResult = ReturnType<typeof useContainerQuery>;

/**
 * Returns a referentially-stable subset of a container-query result whose
 * identity only changes when a *breakpoint boolean* actually crosses — not on
 * every ResizeObserver tick. The raw `useContainerQuery` object gets a fresh
 * `width`/`height` (and therefore a fresh object identity) on every observed
 * pixel change, which busts the `memo` of any consumer that only reads the
 * booleans (e.g. the home shelves' GridCarousel) and re-renders large trees
 * needlessly.
 *
 * `ref` identity is preserved from the source so the ResizeObserver stays
 * attached. `width`/`height` are carried through but intentionally snapshotted
 * to the last breakpoint-crossing values: no consumer of the stable variant
 * reads them, and pinning them keeps the object identity stable.
 */
export const useStableContainerQuery = (source: ContainerQueryResult): ContainerQueryResult => {
    const {
        height,
        is2xl,
        is3xl,
        is4xl,
        is5xl,
        isCalculated,
        isLg,
        isMd,
        isSm,
        isXl,
        isXs,
        ref,
        width,
    } = source;

    return useMemo(
        () => ({
            height,
            is2xl,
            is3xl,
            is4xl,
            is5xl,
            isCalculated,
            isLg,
            isMd,
            isSm,
            isXl,
            isXs,
            ref,
            width,
        }),
        // Width/height deliberately excluded — only re-create the object when a
        // breakpoint boolean (or `ref`) changes. The width/height closed over
        // here are the values at the last crossing, which is fine since no
        // stable-variant consumer reads them.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [is2xl, is3xl, is4xl, is5xl, isCalculated, isLg, isMd, isSm, isXl, isXs, ref],
    );
};
