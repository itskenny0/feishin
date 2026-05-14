import type { ReactNode, Ref } from 'react';

import { motion } from 'motion/react';
import { forwardRef } from 'react';

import styles from './animated-page.module.css';

import { animationProps } from '/@/shared/components/animations/animation-props';

interface AnimatedPageProps {
    children: ReactNode;
}

export const AnimatedPage = forwardRef(
    ({ children }: AnimatedPageProps, ref: Ref<HTMLDivElement>) => {
        return (
            <motion.main
                className={styles.animatedPage}
                ref={ref}
                // 0.5s with `anticipate` easing was visibly slow for what is
                // effectively a same-app route change — felt like a page
                // transition rather than a tab swap. Shorten to 0.18s with a
                // plain easeOut so navigation snaps.
                {...{ ...animationProps.fadeIn, transition: { duration: 0.18, ease: 'easeOut' } }}
            >
                {children}
            </motion.main>
        );
    },
);
