import { useCallback } from 'react';

/**
 * Tiny haptic-feedback utility that uses the standard navigator.vibrate
 * Web API. Available in every modern Android WebView (so it works inside
 * Capacitor without pulling in @capacitor/haptics + the Gradle dance
 * that comes with adding another native plugin), no-ops on iOS Safari
 * (which has never exposed vibrate) and on desktop electron.
 *
 * Intensity presets keep call sites consistent:
 *   - selection (8ms): tab change, button tap, swipe past a step
 *   - impact    (18ms): play/pause toggle, long-press to open menu
 *   - success   ([12,40,12]): favorite-on, completed download
 *   - warning   ([4,20,4,20,4]): destructive confirm preview
 *
 * Pass `null` to skip — useful when wiring into a branch that has both
 * touch and pointer paths.
 */
export type HapticIntensity = 'impact' | 'selection' | 'success' | 'warning';

const PATTERNS: Record<HapticIntensity, number | number[]> = {
    impact: 18,
    selection: 8,
    success: [12, 40, 12],
    warning: [4, 20, 4, 20, 4],
};

const supportsVibrate = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return typeof navigator.vibrate === 'function';
};

/**
 * Direct one-shot version — call from anywhere (event handler, callback).
 * Safe to fire-and-forget; ignored on platforms without vibrate.
 */
export const triggerHaptic = (intensity: HapticIntensity | null = 'selection') => {
    if (intensity === null) return;
    if (!supportsVibrate()) return;
    try {
        navigator.vibrate(PATTERNS[intensity]);
    } catch {
        // Some platforms throw on certain pattern shapes — silently
        // ignore so a haptic miss never breaks a UI action.
    }
};

/**
 * Stable callback hook for use inside components.
 */
export const useHaptic = () => {
    return useCallback((intensity: HapticIntensity | null = 'selection') => {
        triggerHaptic(intensity);
    }, []);
};
