import type { RefObject } from 'react';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './scroll-to-top-button.module.css';

import { ActionIcon } from '/@/shared/components/action-icon/action-icon';

export interface ScrollToTopButtonProps {
    /**
     * Ref to the scrollable element. When omitted, the listener
     * attaches to `window` and uses `document.scrollingElement` as
     * the scroll target. Passing a ref is preferred when the layout
     * scrolls inside a nested container (the default Feishin layout
     * does — see `MainContent`).
     */
    targetRef?: RefObject<HTMLElement | null>;
    /** Threshold in pixels before the button appears. Default 400. */
    threshold?: number;
}

/**
 * Floating action button that appears in the bottom-right corner of
 * the viewport once the user has scrolled past `threshold` pixels.
 * Clicking smooth-scrolls the target back to the top.
 *
 * The listener uses capture-phase scroll on the target element so it
 * also picks up scrolls from descendant scrollable containers (e.g.
 * react-window's virtualised list outer ref, which scrolls inside
 * the main content body but not the body itself).
 */
export const ScrollToTopButton = ({ targetRef, threshold = 400 }: ScrollToTopButtonProps) => {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const ownerElement = targetRef?.current ?? null;

        const computeTop = (): number => {
            if (ownerElement && ownerElement.scrollTop > 0) {
                return ownerElement.scrollTop;
            }
            // When the owner itself hasn't scrolled, look for the
            // deepest descendant that has — react-window mounts its
            // own overflow container inside the body and that's the
            // element that actually scrolls on virtualised lists.
            if (ownerElement) {
                const descendants = ownerElement.querySelectorAll<HTMLElement>('*');
                let max = 0;
                for (const el of descendants) {
                    if (el.scrollTop > max) {
                        max = el.scrollTop;
                    }
                }
                if (max > 0) return max;
            }
            const root = document.scrollingElement ?? document.documentElement;
            return root.scrollTop;
        };

        const onScroll = () => {
            setVisible(computeTop() > threshold);
        };

        onScroll();

        const listenerTarget: EventTarget = ownerElement ?? window;
        // Capture-phase listener so scroll events from nested
        // overflow containers fire here too — scroll events don't
        // bubble, but they DO traverse the capture phase.
        listenerTarget.addEventListener('scroll', onScroll, {
            capture: true,
            passive: true,
        });
        return () => {
            listenerTarget.removeEventListener('scroll', onScroll, { capture: true });
        };
    }, [targetRef, threshold]);

    if (!visible) return null;

    const handleClick = () => {
        const ownerElement = targetRef?.current ?? null;
        const candidates: HTMLElement[] = [];
        if (ownerElement) candidates.push(ownerElement);
        if (ownerElement) {
            // Add any descendant that's actively scrolled; reset all
            // of them so virtualised lists also return to the top.
            ownerElement.querySelectorAll<HTMLElement>('*').forEach((el) => {
                if (el.scrollTop > 0) {
                    candidates.push(el);
                }
            });
        }
        if (candidates.length === 0) {
            const root = document.scrollingElement ?? document.documentElement;
            (root as HTMLElement).scrollTo({ behavior: 'smooth', top: 0 });
            return;
        }
        for (const el of candidates) {
            el.scrollTo({ behavior: 'smooth', top: 0 });
        }
    };

    return (
        <ActionIcon
            aria-label={t('common.scrollToTop', { defaultValue: 'Scroll to top' })}
            className={styles.fab}
            icon="arrowUp"
            iconProps={{ size: 'lg' }}
            onClick={handleClick}
            radius="xl"
            size="lg"
            variant="filled"
        />
    );
};
