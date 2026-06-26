import type { ReactNode, Ref } from 'react';

import { motion, useReducedMotion } from 'motion/react';
import { forwardRef } from 'react';

import styles from './animated-page.module.css';

import { usePerfRouteMount } from '/@/renderer/lib/perf-log';
import { animationProps } from '/@/shared/components/animations/animation-props';

interface AnimatedPageProps {
    children: ReactNode;
}

export const AnimatedPage = forwardRef(
    ({ children }: AnimatedPageProps, ref: Ref<HTMLDivElement>) => {
        // Honor the OS-level reduced-motion preference. When set we skip the
        // fade-in entirely so users with vestibular sensitivity don't get a
        // page flash on every navigation.
        // Perf: every route renders through AnimatedPage, so logging its mount
        // here gives a `[perf] route` settle time (relative to the last nav) for
        // every surface without per-route wiring. The `path` field identifies
        // which route.
        usePerfRouteMount('page');
        const reduced = useReducedMotion();
        const transitionProps = reduced
            ? { animate: { opacity: 1 }, initial: { opacity: 1 }, transition: { duration: 0 } }
            : {
                  ...animationProps.fadeIn,
                  transition: { duration: 0.18, ease: 'easeOut' as const },
              };

        return (
            // Renders as a plain <div>: the semantic <main> landmark lives
            // in default-layout/main-content.tsx so it stays stable across
            // route transitions and we don't end up with nested <main>s.
            <motion.div
                className={styles.animatedPage}
                ref={ref}
                // 0.5s with `anticipate` easing was visibly slow for what is
                // effectively a same-app route change — felt like a page
                // transition rather than a tab swap. Shorten to 0.18s with a
                // plain easeOut so navigation snaps.
                {...transitionProps}
            >
                {children}
            </motion.div>
        );
    },
);
