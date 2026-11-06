// The browser claims a touch drag for scrolling after its first move (and
// fires pointercancel), so the pull has to cancel touchmove itself while it
// is in progress, or it never reaches the trigger distance.

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/renderer/hooks/use-haptic', () => ({ triggerHaptic: vi.fn() }));

import { usePullToRefresh } from '/@/renderer/hooks/use-pull-to-refresh';

const pointer = (type: string, clientY: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { clientX: 100, clientY, pointerId: 1, pointerType: 'touch' });
    return event;
};

const touchMove = (clientY: number) => {
    const event = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.assign(event, { touches: [{ clientX: 100, clientY }] });
    return event;
};

const setup = (scrollTop = 0) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    Object.defineProperty(el, 'scrollTop', { value: scrollTop });
    document.body.appendChild(el);
    renderHook(() => usePullToRefresh({ current: el }, { onRefresh: vi.fn() }));
    return el;
};

describe('usePullToRefresh touch handling', () => {
    it('keeps a downward pull from the top away from the browser scroller', () => {
        const el = setup();
        el.dispatchEvent(pointer('pointerdown', 40));
        const move = touchMove(90);
        el.dispatchEvent(move);
        expect(move.defaultPrevented).toBe(true);
    });

    it('lets an upward move scroll normally', () => {
        const el = setup();
        el.dispatchEvent(pointer('pointerdown', 40));
        const move = touchMove(10);
        el.dispatchEvent(move);
        expect(move.defaultPrevented).toBe(false);
    });

    it('never blocks scrolling when the content is not at the top', () => {
        const el = setup(120);
        el.dispatchEvent(pointer('pointerdown', 40));
        const move = touchMove(90);
        el.dispatchEvent(move);
        expect(move.defaultPrevented).toBe(false);
    });
});
