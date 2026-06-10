import { useEffect, useRef, useState } from 'react';

/**
 * Detects whether the on-screen (soft) keyboard is currently visible.
 *
 * The app has no native `@capacitor/keyboard` plugin installed, so detection
 * rides on `window.visualViewport`: when a soft keyboard opens, the *visual*
 * viewport shrinks (the keyboard eats screen real-estate) while the *layout*
 * viewport — `window.innerHeight` — stays the same. A shrink larger than
 * `thresholdPx` between the two is read as "keyboard open". This is the
 * standard web heuristic and works on Android Chrome / WebView and iOS Safari
 * / WKWebView alike.
 *
 * We compare against the larger of `window.innerHeight` and the largest
 * visual-viewport height seen so far. The max-seen guard means the heuristic
 * survives platforms (some Android WebView configs) where `window.innerHeight`
 * is itself reduced when the keyboard is up — there the *delta from the peak*
 * still crosses the threshold.
 *
 * Gated by `enabled`: callers pass `false` on desktop / non-touch shells so a
 * window resize (which also shrinks the viewport) never hides UI there.
 *
 * @example
 *   const keyboardVisible = useSoftKeyboardVisible({ enabled: isMobileNative });
 */
interface UseSoftKeyboardVisibleOptions {
    /**
     * When false the hook is inert and always returns `false`. Use this to
     * scope the behaviour to touch / native contexts.
     */
    enabled?: boolean;
    /**
     * Minimum viewport shrink (CSS px) to treat as a keyboard. 150px clears
     * URL-bar collapse / toolbar chrome (~50–120px) but sits well under any
     * real soft keyboard (~250px+).
     */
    thresholdPx?: number;
}

export const useSoftKeyboardVisible = ({
    enabled = true,
    thresholdPx = 150,
}: UseSoftKeyboardVisibleOptions = {}): boolean => {
    const [visible, setVisible] = useState(false);
    // Largest visual-viewport height observed — our baseline for the "shrink".
    const maxHeightRef = useRef(0);

    useEffect(() => {
        if (!enabled) {
            setVisible(false);
            return;
        }

        const vv = typeof window !== 'undefined' ? window.visualViewport : null;
        if (!vv) return;

        // Seed the baseline from whatever's tallest right now.
        maxHeightRef.current = Math.max(window.innerHeight || 0, vv.height);

        let last = false;

        const evaluate = () => {
            const baseline = Math.max(maxHeightRef.current, window.innerHeight || 0, vv.height);
            maxHeightRef.current = baseline;
            const next = baseline - vv.height > thresholdPx;
            if (next !== last) {
                last = next;
                // Lifecycle log — new subsystems ship with tagged logging.
                console.info(
                    `[keyboard] ${next ? 'visible' : 'hidden'} (viewport ${Math.round(
                        vv.height,
                    )}px / baseline ${Math.round(baseline)}px)`,
                );
                setVisible(next);
            }
        };

        vv.addEventListener('resize', evaluate);
        // `scroll` fires on some platforms when the keyboard pans the viewport;
        // re-evaluate there too so we don't miss a transition.
        vv.addEventListener('scroll', evaluate);
        // Run once in case the keyboard is already up at mount.
        evaluate();

        return () => {
            vv.removeEventListener('resize', evaluate);
            vv.removeEventListener('scroll', evaluate);
        };
    }, [enabled, thresholdPx]);

    return visible;
};
