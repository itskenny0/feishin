import isElectron from 'is-electron';
import { useEffect, useRef } from 'react';

const GARBAGE_COLLECTION_INTERVAL = 1000 * 60 * 5;

// Run the (relatively expensive) synchronous V8 GC only when the main thread is
// idle so it can never land inside a navigation/animation frame. Falls back to a
// plain call if the browser doesn't expose requestIdleCallback.
const scheduleGarbageCollection = () => {
    const win = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    };

    const run = () => {
        window.api?.utils?.forceGarbageCollection?.();
    };

    if (typeof win.requestIdleCallback === 'function') {
        win.requestIdleCallback(run, { timeout: 2000 });
    } else {
        run();
    }
};

export const useGarbageCollection = () => {
    const intervalIdRef = useRef<NodeJS.Timeout | null>(null);

    // Periodically nudge V8 to release retained memory. The navigation-triggered
    // GC was removed: forcing a full synchronous heap collection on every route
    // change stalled the transition frame. The periodic sweep now runs through
    // requestIdleCallback so it never blocks an interactive frame.
    useEffect(() => {
        if (!isElectron()) {
            return undefined;
        }

        intervalIdRef.current = setInterval(() => {
            scheduleGarbageCollection();
        }, GARBAGE_COLLECTION_INTERVAL);

        return () => {
            if (intervalIdRef.current) {
                clearInterval(intervalIdRef.current);
                intervalIdRef.current = null;
            }
        };
    }, []);
};
