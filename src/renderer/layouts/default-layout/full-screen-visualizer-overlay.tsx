import { AnimatePresence } from 'motion/react';
import { lazy, Suspense } from 'react';

import { useFullScreenPlayerVisualizerExpanded } from '/@/renderer/store/full-screen-player.store';

// Lazy-load the visualizer (already conditionally rendered) so its WebGL /
// canvas graph stays out of the first-paint entry chunk and only loads when
// the user actually expands the visualizer.
const FullScreenVisualizer = lazy(() =>
    import('/@/renderer/features/player/components/full-screen-visualizer').then((m) => ({
        default: m.FullScreenVisualizer,
    })),
);

export const FullScreenVisualizerOverlay = () => {
    const isFullScreenVisualizerExpanded = useFullScreenPlayerVisualizerExpanded();

    return (
        <AnimatePresence initial={false}>
            {isFullScreenVisualizerExpanded && (
                <Suspense fallback={null}>
                    <FullScreenVisualizer />
                </Suspense>
            )}
        </AnimatePresence>
    );
};
