import { MantineProvider } from '@mantine/core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseTextScrolling } from '/@/shared/components/text-scrolling/text-scrolling';

describe('BaseTextScrolling', () => {
    const animatedElements: Element[] = [];

    beforeEach(() => {
        // Every title overflows by the same amount, as two long titles that
        // differ only in a (tabular) digit would.
        vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(500);
        vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(100);
        Element.prototype.animate = vi.fn(function (this: Element) {
            animatedElements.push(this);
            return { cancel: () => {}, finished: new Promise(() => {}) };
        }) as any;
        Element.prototype.getAnimations = () => [];
        // jsdom's rAF timestamp runs on a different clock than performance.now().
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
            setTimeout(() => cb(performance.now()), 0),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        animatedElements.length = 0;
    });

    const renderTitle = (title: string) => (
        <MantineProvider>
            <BaseTextScrolling gap={10} pause={0} speed={50}>
                {title}
            </BaseTextScrolling>
        </MantineProvider>
    );

    it('scrolls the new track when the title changes to one of equal width', async () => {
        const { container, rerender } = render(renderTitle('Chapter 12'));
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(animatedElements).toHaveLength(1);

        rerender(renderTitle('Chapter 13'));
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

        const track = container.querySelector('[style*="--scroll-gap"]');
        expect(track).not.toBe(animatedElements[0]);
        expect(animatedElements).toContain(track);
    });
});
