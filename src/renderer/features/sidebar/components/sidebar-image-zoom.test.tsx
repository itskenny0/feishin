import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImageZoomLightbox } from '/@/renderer/features/sidebar/components/sidebar';

// The lightbox is portalled but still a React child of the sidebar cover,
// whose click toggles the full-screen player: closing the lightbox must not
// reach it.
describe('ImageZoomLightbox', () => {
    it('closes on backdrop click without bubbling to the sidebar cover', () => {
        const onClose = vi.fn();
        const onCoverClick = vi.fn();
        const onCoverContextMenu = vi.fn();

        render(
            <MantineProvider>
                <div onClick={onCoverClick} onContextMenu={onCoverContextMenu}>
                    <ImageZoomLightbox imageUrl="blob:cover" onClose={onClose} opened />
                </div>
            </MantineProvider>,
        );

        const overlay = screen.getByRole('dialog');
        fireEvent.click(overlay);
        fireEvent.contextMenu(overlay);

        expect(onClose).toHaveBeenCalled();
        expect(onCoverClick).not.toHaveBeenCalled();
        expect(onCoverContextMenu).not.toHaveBeenCalled();
    });
});
