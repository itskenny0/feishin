import { useOverlayScrollbars } from 'overlayscrollbars-react';
import { CSSProperties, forwardRef, memo, ReactNode, Ref, useEffect, useRef } from 'react';

import styles from './native-scroll-area.module.css';

import { PageHeader, PageHeaderProps } from '/@/renderer/components/page-header/page-header';
import { useWindowSettings } from '/@/renderer/store/settings.store';
import { useMergedRef } from '/@/shared/hooks/use-merged-ref';
import { useThrottledCallback } from '/@/shared/hooks/use-throttled-callback';
import { Platform } from '/@/shared/types/types';

// Module-level cache keyed by `scrollKey` so navigating back into a list
// restores the position the user left it at. Bounded only by the number of
// distinct routes visited — fine for a music app, and entries are tiny
// (number per key).
const scrollPositionCache = new Map<string, number>();

interface NativeScrollAreaProps {
    children: ReactNode;
    debugScrollPosition?: boolean;
    noHeader?: boolean;
    pageHeaderProps?: PageHeaderProps & { offset: number; target?: any };
    scrollBarOffset?: string;
    scrollHideDelay?: number;
    /**
     * Stable per-route identifier (e.g. the route path or a list pageKey).
     * When provided, the scroll position is persisted across mounts so
     * back-navigation restores the user's place in long lists. Without it
     * the scroll area behaves as before (no persistence).
     */
    scrollKey?: string;
    style?: CSSProperties;
}

const BaseNativeScrollArea = forwardRef(
    (
        {
            children,
            noHeader,
            pageHeaderProps,
            scrollHideDelay,
            scrollKey,
            ...props
        }: NativeScrollAreaProps,
        ref: Ref<HTMLDivElement>,
    ) => {
        const { windowBarStyle } = useWindowSettings();
        const containerRef = useRef<HTMLDivElement | null>(null);
        // Populated by PageHeader with its visibility recompute fn. We call it
        // from the throttled scroll handler below so the header reacts to
        // `data-scrolled` changes without its own MutationObserver.
        const headerVisibilityUpdaterRef = useRef<(() => void) | null>(null);

        const scrollHandler = useThrottledCallback((e: Event) => {
            const scrollElement = e?.target as HTMLDivElement;
            if (!scrollElement) return;

            // Persist position for back-navigation restore. Throttled (100ms)
            // so a fast scroll doesn't write every frame.
            if (scrollKey) {
                scrollPositionCache.set(scrollKey, scrollElement.scrollTop);
            }

            if (noHeader || !pageHeaderProps) {
                return;
            }

            if (!containerRef.current) {
                return;
            }

            const offset = pageHeaderProps.offset || 0;
            const scrollTop = scrollElement.scrollTop;

            if (scrollTop > offset) {
                containerRef.current.setAttribute('data-scrolled', 'true');
            } else {
                containerRef.current.setAttribute('data-scrolled', 'false');
            }

            // Drive the header's visibility off this same throttled tick now
            // that it no longer runs its own MutationObserver.
            headerVisibilityUpdaterRef.current?.();
        }, 100);

        const [initialize] = useOverlayScrollbars({
            defer: false,
            events: {
                scroll: (_instance, e) => {
                    scrollHandler(e);
                },
            },
            options: {
                overflow: { x: 'hidden', y: 'scroll' },
                scrollbars: {
                    autoHide: 'leave',
                    autoHideDelay: scrollHideDelay || 500,
                    pointers: ['mouse', 'pen', 'touch'],
                    theme: 'feishin-os-scrollbar',
                    visibility: 'visible',
                },
            },
        });

        useEffect(() => {
            if (containerRef.current) {
                initialize(containerRef.current as HTMLDivElement);
                if (!noHeader && pageHeaderProps) {
                    containerRef.current.setAttribute('data-scrolled', 'false');
                }
                // Restore the saved scroll position for this route once
                // children have laid out. rAF gives the browser one frame
                // to paint the initial content so the scrollTop assignment
                // doesn't snap to 0 before the inner content has height.
                if (scrollKey) {
                    const saved = scrollPositionCache.get(scrollKey);
                    if (saved && saved > 0) {
                        requestAnimationFrame(() => {
                            if (containerRef.current) {
                                containerRef.current.scrollTop = saved;
                            }
                        });
                    }
                }
            }
        }, [initialize, noHeader, pageHeaderProps, scrollKey]);

        const mergedRef = useMergedRef(ref, containerRef);

        return (
            <>
                {windowBarStyle === Platform.WEB && <div className={styles.dragContainer} />}
                {!noHeader && pageHeaderProps && (
                    <PageHeader
                        animated
                        position="absolute"
                        scrollContainerRef={containerRef}
                        visibilityUpdaterRef={headerVisibilityUpdaterRef}
                        {...pageHeaderProps}
                    />
                )}
                <div className={styles.scrollArea} ref={mergedRef} {...props}>
                    {children}
                </div>
            </>
        );
    },
);

export const NativeScrollArea = memo(BaseNativeScrollArea);

NativeScrollArea.displayName = 'NativeScrollArea';
