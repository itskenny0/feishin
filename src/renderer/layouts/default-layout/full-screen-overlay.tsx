import { AnimatePresence } from 'motion/react';

import { FullScreenPlayer } from '/@/renderer/features/player/components/full-screen-player';
import { useFullScreenPlayerExpanded } from '/@/renderer/store';

export const FullScreenOverlay = () => {
    const isFullScreenPlayerExpanded = useFullScreenPlayerExpanded();

    return (
        <AnimatePresence initial={false}>
            {isFullScreenPlayerExpanded && <FullScreenPlayer />}
        </AnimatePresence>
    );
};
