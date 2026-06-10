import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Idle-hide state machine for overlay controls: visible on activity, hidden
 * after `timeoutMs` of quiet. Call `revealControls` from activity events
 * (mousemove / pointerdown / touchstart). Extracted from the full-screen
 * visualizer overlay so every visualizer surface shares one behaviour.
 */
export const useIdleControls = (timeoutMs = 3500) => {
    const [controlsVisible, setControlsVisible] = useState(true);
    const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const revealControls = useCallback(() => {
        setControlsVisible(true);
        if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
        }
        idleTimerRef.current = setTimeout(() => {
            setControlsVisible(false);
        }, timeoutMs);
    }, [timeoutMs]);

    useEffect(() => {
        revealControls();
        return () => {
            if (idleTimerRef.current) {
                clearTimeout(idleTimerRef.current);
            }
        };
    }, [revealControls]);

    return { controlsVisible, revealControls };
};
