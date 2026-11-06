import type { RefObject } from 'react';

import { useEffect, useRef, useState } from 'react';

/**
 * Hook: detect whether the referenced element is overflowing
 * horizontally and would therefore be rendering an ellipsis.
 *
 * Compares scrollWidth vs clientWidth on a ResizeObserver. Returns a
 * ref to attach to the element and a boolean truncation flag. The
 * caller is responsible for the CSS that triggers the ellipsis itself
 * (overflow: hidden; text-overflow: ellipsis; white-space: nowrap).
 *
 * A 1px slack guards against subpixel rounding on Hi-DPI displays
 * where the two values can disagree by a fraction without an actual
 * ellipsis being drawn.
 */
export const useTruncationDetection = <T extends HTMLElement>(
    deps: readonly unknown[] = [],
): { isTruncated: boolean; ref: RefObject<null | T> } => {
    const ref = useRef<null | T>(null);
    const [isTruncated, setIsTruncated] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const check = () => {
            setIsTruncated(el.scrollWidth - el.clientWidth > 1);
        };

        check();

        const ro = new ResizeObserver(check);
        ro.observe(el);

        return () => {
            ro.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    return { isTruncated, ref };
};
