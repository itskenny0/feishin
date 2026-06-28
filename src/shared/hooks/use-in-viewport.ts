import { useCallback, useEffect, useRef, useState } from 'react';

// Replacement for Mantine's `useInViewport`. The Mantine hook left
// above-the-fold covers gated OFF on a fresh mount: a cover is a cache-only
// resolve gated behind `inViewport` (see image.tsx `shouldLoadImage`), and the
// IntersectionObserver's first async callback didn't surface the INITIAL
// in-view state in time on a cold mount, so the home read blank until a scroll
// nudged the observer. Two changes fix that without bulk-loading long lists:
//   1. SEED the initial in-view state SYNCHRONOUSLY from layout
//      (getBoundingClientRect) the instant the node attaches — an element
//      already on screen reports in-view immediately, no scroll required. The
//      eager-load workaround on the pinned shelf proved the gate was exactly
//      this; the seed generalises that to every viewport-gated cover.
//   2. A small rootMargin pre-resolves covers just before they scroll in.
// Off-screen elements stay gated (the seed is conditional on being on screen,
// and the observer reports false for them), so a 1000-row list still only
// resolves the handful actually visible. Guarded for the test env: jsdom has no
// IntersectionObserver and getBoundingClientRect returns a 0-box, so this
// degrades to `inViewport === false` exactly like the previous Mantine re-export.

const ROOT_MARGIN_PX = 100;

export const useInViewport = <T extends HTMLElement = HTMLElement>() => {
    const [inViewport, setInViewport] = useState(false);
    const observerRef = useRef<IntersectionObserver | null>(null);

    const ref = useCallback((node: null | T) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        if (!node || typeof IntersectionObserver === 'undefined') return;

        // (1) Synchronous seed from layout — covers the cold-mount race where
        // the observer's first async callback is missed.
        const rect = node.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        const onScreen =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top < vh + ROOT_MARGIN_PX &&
            rect.bottom > -ROOT_MARGIN_PX &&
            rect.left < vw + ROOT_MARGIN_PX &&
            rect.right > -ROOT_MARGIN_PX;
        if (onScreen) setInViewport(true);

        // (2) Observer for subsequent scroll in/out. A cover that already
        // loaded stays painted when it scrolls out (image.tsx keeps it via
        // `hasLoadedInInstance`), so dropping back to false here never unloads.
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[entries.length - 1];
                if (entry) setInViewport(entry.isIntersecting);
            },
            { rootMargin: `${ROOT_MARGIN_PX}px` },
        );
        observer.observe(node);
        observerRef.current = observer;
    }, []);

    useEffect(
        () => () => {
            observerRef.current?.disconnect();
            observerRef.current = null;
        },
        [],
    );

    return { inViewport, ref };
};
