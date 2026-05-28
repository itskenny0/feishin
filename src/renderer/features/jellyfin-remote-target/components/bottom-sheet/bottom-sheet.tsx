import type { ReactNode } from 'react';

import { animate, AnimatePresence, motion, useMotionValue } from 'motion/react';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useBottomSheetStore } from './bottom-sheet-store';
import styles from './bottom-sheet.module.css';

import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Text } from '/@/shared/components/text/text';

interface BottomSheetProps {
    /** Optional accessible label override; defaults to `title`. */
    ariaLabel?: string;
    children: ReactNode;
    onClose: () => void;
    opened: boolean;
    /** Visible header title rendered next to the close button. */
    title: ReactNode;
}

/**
 * Mobile bottom sheet that:
 *
 * - sizes to its content (capped at 75vh) so a 3-row sheet never fills
 *   the whole screen,
 * - respects `env(safe-area-inset-top)` so the OS status-bar clock /
 *   battery indicators never paint on top of the title,
 * - exposes a visible drag-pill plus an explicit X close button in the
 *   header,
 * - dismisses on backdrop tap, swipe-down past a threshold or with a
 *   downward flick, and on the Android hardware back gesture (via the
 *   shared `useBottomSheetStore` registry consumed by
 *   `useAndroidBackButton`).
 *
 * The swipe / dismiss animation mirrors `MobileFullscreenPlayer` so the
 * picker and the player feel like the same surface family.
 */
export const BottomSheet = ({ ariaLabel, children, onClose, opened, title }: BottomSheetProps) => {
    const { t } = useTranslation();
    const sheetRef = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    /**
     * Vertical translate of the sheet, in pixels. 0 = fully on-screen,
     * positive = pulled down (toward dismiss). We seed it with the
     * sheet's expected height so the entrance slide-up reads as "rising
     * from the bottom edge" rather than a fade-in mid-air. The real
     * height is measured on first paint and used for the dismiss
     * animation.
     */
    const sheetH = typeof window !== 'undefined' ? Math.min(window.innerHeight, 600) : 600;
    const swipeY = useMotionValue(sheetH);
    const id = useId();
    const titleId = `${id}-title`;

    // Register a dismiss handler so the Android back gesture closes
    // this sheet rather than navigating away / exiting the app.
    useEffect(() => {
        if (!opened) return;
        const sheetId = `bottom-sheet:${id}`;
        useBottomSheetStore.getState().push(sheetId, onClose);
        return () => {
            useBottomSheetStore.getState().remove(sheetId);
        };
    }, [opened, id, onClose]);

    // Entrance slide-up. We re-arm whenever the sheet (re-)opens so a
    // re-open after a swipe-dismiss animates back in cleanly.
    useEffect(() => {
        if (!opened) return;
        const controls = animate(swipeY, 0, { duration: 0.28, ease: 'easeOut' });
        return () => controls.stop();
    }, [opened, swipeY]);

    // Non-passive native touch listener for swipe-to-dismiss. Mirrors
    // the pattern in mobile-fullscreen-player.tsx — Motion's `drag` prop
    // can't preventDefault in time to win the gesture against the
    // browser's overscroll bounce, so we listen directly on the sheet
    // and call preventDefault on the first downward move once we've
    // claimed the gesture.
    useEffect(() => {
        const el = sheetRef.current;
        if (!el || !opened) return;
        let startY = 0;
        let startX = 0;
        let lastY = 0;
        let lastTime = 0;
        let active = false;
        let claimed = false;

        const onTouchStart = (e: TouchEvent) => {
            const touch = e.touches[0];
            if (!touch) return;
            // If the gesture starts inside a scrollable body that has
            // already scrolled away from the top, defer to native scroll.
            const body = bodyRef.current;
            if (body && body.contains(e.target as Node) && body.scrollTop > 0) return;
            startX = touch.clientX;
            startY = touch.clientY;
            lastY = startY;
            lastTime = performance.now();
            active = true;
            claimed = false;
        };

        const onTouchMove = (e: TouchEvent) => {
            if (!active) return;
            const touch = e.touches[0];
            if (!touch) return;
            const dy = touch.clientY - startY;
            const dx = Math.abs(touch.clientX - startX);

            if (!claimed) {
                if (Math.abs(dy) < 4) return;
                if (dy < 0) {
                    // Upward — let the native scroll have it.
                    active = false;
                    return;
                }
                if (dx > Math.abs(dy)) {
                    // Mostly horizontal — bail.
                    active = false;
                    return;
                }
                claimed = true;
                console.info('[bottom-sheet] gesture-start');
            }

            e.preventDefault();
            // Mild rubber-band so the drag feels weighty, not 1:1.
            swipeY.set(Math.max(0, dy * 0.75));
            lastY = touch.clientY;
            lastTime = performance.now();
        };

        const onTouchEnd = () => {
            if (!active) return;
            const wasClaimed = claimed;
            active = false;
            claimed = false;
            if (!wasClaimed) return;

            const offset = swipeY.get();
            const elapsed = Math.max(16, performance.now() - lastTime);
            const recentDy = lastY - startY;
            const velocity = (recentDy / elapsed) * 1000;

            const height = el.getBoundingClientRect().height || sheetH;
            if (offset > 120 || velocity > 500) {
                console.info('[bottom-sheet] dismiss via swipe');
                animate(swipeY, height, {
                    duration: 0.22,
                    ease: 'easeOut',
                    onComplete: () => {
                        onClose();
                        swipeY.set(height);
                    },
                });
            } else {
                animate(swipeY, 0, { damping: 30, stiffness: 380, type: 'spring' });
            }
        };

        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        el.addEventListener('touchcancel', onTouchEnd, { passive: true });
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
        };
    }, [opened, onClose, sheetH, swipeY]);

    // Close on Escape (Android back-button handler dispatches it; also
    // helps desktop / web with a physical keyboard hooked up).
    useEffect(() => {
        if (!opened) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [opened, onClose]);

    return (
        <AnimatePresence>
            {opened && (
                <>
                    <motion.div
                        animate={{ opacity: 1 }}
                        aria-hidden
                        className={styles.backdrop}
                        data-testid="bottom-sheet-backdrop"
                        exit={{ opacity: 0 }}
                        initial={{ opacity: 0 }}
                        onClick={onClose}
                        transition={{ duration: 0.18 }}
                    />
                    <motion.div
                        aria-labelledby={titleId}
                        aria-modal="true"
                        className={styles.sheet}
                        data-testid="bottom-sheet"
                        ref={sheetRef}
                        role="dialog"
                        style={{ y: swipeY }}
                        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
                    >
                        <div className={styles.header}>
                            <div aria-hidden className={styles.dragHandle}>
                                <div className={styles.dragHandlePill} />
                            </div>
                            <div className={styles.titleRow}>
                                <Text className={styles.title} id={titleId}>
                                    {title}
                                </Text>
                                <ActionIcon
                                    aria-label={t('common.close', { defaultValue: 'Close' })}
                                    data-testid="bottom-sheet-close"
                                    icon="x"
                                    iconProps={{ size: 'lg' }}
                                    onClick={onClose}
                                    size="md"
                                    variant="subtle"
                                />
                            </div>
                        </div>
                        <div className={styles.body} ref={bodyRef}>
                            {children}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};
