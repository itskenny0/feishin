import { AnimatePresence } from 'motion/react';

import { FullScreenVisualizer } from '/@/renderer/features/player/components/full-screen-visualizer';
import { useFullScreenPlayerVisualizerExpanded } from '/@/renderer/store/full-screen-player.store';

export const FullScreenVisualizerOverlay = () => {
    const isFullScreenVisualizerExpanded = useFullScreenPlayerVisualizerExpanded();

    return (
        <AnimatePresence initial={false}>
            {isFullScreenVisualizerExpanded && <FullScreenVisualizer />}
        </AnimatePresence>
    );
};
