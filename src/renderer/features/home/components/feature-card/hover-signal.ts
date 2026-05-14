/**
 * Tiny shared signal so the feature-card's rotation pool (which lives in data
 * hooks via {@link usePoolRotation}) can see the shell's hover state without a
 * round-trip through props or a zustand store.
 *
 * Why a module-level ref and not React state: the rotation tick is a
 * setInterval callback that reads the latest hover state synchronously at
 * fire-time. React state would only be visible on the next render, which is
 * fine for display but pointless for an internal timer decision.
 */
const ref = { hovered: false };

export const setFeatureCardHovered = (hovered: boolean): void => {
    ref.hovered = hovered;
};

export const isFeatureCardHovered = (): boolean => ref.hovered;
