import clsx from 'clsx';
import { useInView } from 'motion/react';
import { AnimatePresence, motion, Variants } from 'motion/react';
import {
    CSSProperties,
    memo,
    MutableRefObject,
    ReactNode,
    RefObject,
    useEffect,
    useRef,
} from 'react';

import styles from './page-header.module.css';

import { LibraryBackgroundOverlay } from '/@/renderer/features/shared/components/library-background-overlay';
import { useShouldPadTitlebar } from '/@/renderer/hooks';
import { useWindowSettings } from '/@/renderer/store/settings.store';
import { Flex, FlexProps } from '/@/shared/components/flex/flex';
import { Platform } from '/@/shared/types/types';

export interface PageHeaderProps extends Omit<
    FlexProps,
    'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
> {
    animated?: boolean;
    backgroundColor?: string;
    children?: ReactNode;
    height?: string;
    isHidden?: boolean;
    position?: string;
    scrollContainerRef?: RefObject<HTMLDivElement | null>;
    target?: RefObject<HTMLElement | null>;
    /**
     * Populated by the header with a function that recomputes its
     * `data-visible` state from the scroll container's current
     * `data-scrolled` attribute. The scroll owner (NativeScrollArea) calls it
     * from its existing throttled scroll handler, so the header no longer needs
     * its own MutationObserver to react to scroll changes.
     */
    visibilityUpdaterRef?: MutableRefObject<(() => void) | null>;
}

const variants: Variants = {
    animate: {
        opacity: 1,
        transition: {
            duration: 0.3,
            ease: 'easeIn',
        },
    },
    exit: { opacity: 0 },
    initial: { opacity: 0 },
};

const BasePageHeader = ({
    animated,
    backgroundColor,
    children,
    height,
    isHidden,
    position,
    scrollContainerRef,
    target,
    visibilityUpdaterRef,
    ...props
}: PageHeaderProps) => {
    const ref = useRef(null);
    const padRight = useShouldPadTitlebar();
    const { windowBarStyle } = useWindowSettings();

    // Only observe an intersection target when one is actually provided —
    // detail routes that fade the header in once the page title scrolls out of
    // view. Without a target this stays false and adds no observer.
    const hasTarget = Boolean(target);
    const isInView = useInView({
        current: target?.current || null,
    });
    const effectiveInView = hasTarget && isInView;

    // Keep the latest scroll-dependent inputs in refs so the updater the scroll
    // owner calls always reads fresh values without being recreated each render.
    const effectiveInViewRef = useRef(effectiveInView);
    effectiveInViewRef.current = effectiveInView;
    const isHiddenRef = useRef(isHidden);
    isHiddenRef.current = isHidden;

    useEffect(() => {
        const headerElement = ref.current as HTMLElement | null;
        const scrollContainer = scrollContainerRef?.current;

        if (!scrollContainerRef) {
            if (headerElement) {
                headerElement.setAttribute('data-visible', isHidden ? 'false' : 'true');
            }
            return undefined;
        }

        if (!scrollContainer || !headerElement) {
            if (headerElement) {
                headerElement.setAttribute('data-visible', 'false');
            }
            return undefined;
        }

        // Recompute visibility from the scroll container's current
        // `data-scrolled` flag. The scroll owner writes that flag in its
        // throttled scroll handler and then invokes this same function via
        // `visibilityUpdaterRef`, so we react to scroll without a dedicated
        // MutationObserver. We still run it on mount and whenever `isInView`
        // changes (intersection observer fires independently of scroll events).
        const updateVisibility = () => {
            const isScrolled = scrollContainer.getAttribute('data-scrolled') === 'true';
            const shouldShow = isScrolled && !effectiveInViewRef.current;
            headerElement.setAttribute('data-visible', shouldShow ? 'true' : 'false');
        };

        updateVisibility();

        if (visibilityUpdaterRef) {
            visibilityUpdaterRef.current = updateVisibility;
        }

        return () => {
            if (visibilityUpdaterRef && visibilityUpdaterRef.current === updateVisibility) {
                visibilityUpdaterRef.current = null;
            }
        };
    }, [effectiveInView, scrollContainerRef, isHidden, visibilityUpdaterRef]);

    return (
        <>
            <Flex
                className={styles.container}
                data-visible="false"
                ref={ref}
                style={
                    {
                        height,
                        position: position as CSSProperties['position'],
                        // Spotify fades the bar to the page's extracted accent
                        // color; expose it to the CSS color-fade transition.
                        ...(backgroundColor ? { '--page-header-bg': backgroundColor } : {}),
                    } as CSSProperties
                }
                {...props}
            >
                <div
                    className={clsx(styles.header, {
                        [styles.hidden]: isHidden,
                        [styles.isDraggable]: windowBarStyle === Platform.WEB,
                        [styles.padRight]: padRight,
                    })}
                >
                    <AnimatePresence initial={animated ?? false}>
                        <motion.div
                            animate="animate"
                            className={styles.titleWrapper}
                            exit="exit"
                            initial="initial"
                            variants={variants}
                        >
                            {children}
                        </motion.div>
                    </AnimatePresence>
                </div>
                {backgroundColor && (
                    <LibraryBackgroundOverlay backgroundColor={backgroundColor} headerRef={ref} />
                )}
            </Flex>
        </>
    );
};

export const PageHeader = memo(BasePageHeader);

PageHeader.displayName = 'PageHeader';
