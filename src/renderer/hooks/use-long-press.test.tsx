import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLongPress } from '/@/renderer/hooks/use-long-press';

// Haptics are a side effect we don't want firing in jsdom; assert it's
// invoked on long-press instead.
const triggerHaptic = vi.fn();
vi.mock('/@/renderer/hooks/use-haptic', () => ({
    triggerHaptic: (...args: unknown[]) => triggerHaptic(...args),
}));

type PointerInit = Partial<{
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType: string;
}>;

// Minimal React.PointerEvent stand-in carrying the fields the hook reads.
const pointerEvent = (init: PointerInit = {}) =>
    ({
        clientX: init.clientX ?? 0,
        clientY: init.clientY ?? 0,
        pointerId: init.pointerId ?? 1,
        pointerType: init.pointerType ?? 'touch',
    }) as unknown as React.PointerEvent<HTMLElement>;

const mouseEvent = () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = { preventDefault, stopPropagation } as unknown as React.MouseEvent<HTMLElement>;
    return { event, preventDefault, stopPropagation };
};

describe('useLongPress', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        triggerHaptic.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires onPress (not onLongPress) on a short touch tap', () => {
        const onLongPress = vi.fn();
        const onPress = vi.fn();
        const { result } = renderHook(() => useLongPress({ onLongPress, onPress }));

        act(() => {
            result.current.onPointerDown(pointerEvent({ pointerId: 7 }));
        });
        act(() => {
            vi.advanceTimersByTime(200);
            result.current.onPointerUp(pointerEvent({ pointerId: 7 }));
        });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onLongPress).not.toHaveBeenCalled();
        expect(triggerHaptic).not.toHaveBeenCalled();
    });

    it('fires onLongPress + haptic after the hold threshold, and suppresses the trailing click', () => {
        const onLongPress = vi.fn();
        const onPress = vi.fn();
        const { result } = renderHook(() => useLongPress({ onLongPress, onPress }));

        act(() => {
            result.current.onPointerDown(pointerEvent({ pointerId: 3 }));
        });
        act(() => {
            vi.advanceTimersByTime(500);
        });

        expect(onLongPress).toHaveBeenCalledTimes(1);
        expect(triggerHaptic).toHaveBeenCalledWith('impact');

        // pointerup after a long-press must NOT also fire onPress.
        act(() => {
            result.current.onPointerUp(pointerEvent({ pointerId: 3 }));
        });
        expect(onPress).not.toHaveBeenCalled();

        // The browser-synthesised click that follows is swallowed once.
        const first = mouseEvent();
        act(() => {
            result.current.onClickCapture(first.event);
        });
        expect(first.preventDefault).toHaveBeenCalledTimes(1);
        expect(first.stopPropagation).toHaveBeenCalledTimes(1);

        // A later, unrelated click is allowed through.
        const second = mouseEvent();
        act(() => {
            result.current.onClickCapture(second.event);
        });
        expect(second.preventDefault).not.toHaveBeenCalled();
    });

    it('cancels the long-press when the finger drifts past tolerance', () => {
        const onLongPress = vi.fn();
        const onPress = vi.fn();
        const { result } = renderHook(() => useLongPress({ onLongPress, onPress }));

        act(() => {
            result.current.onPointerDown(pointerEvent({ clientX: 0, clientY: 0, pointerId: 1 }));
            result.current.onPointerMove(pointerEvent({ clientX: 40, clientY: 0, pointerId: 1 }));
            vi.advanceTimersByTime(500);
        });

        expect(onLongPress).not.toHaveBeenCalled();

        // Timer was cleared by the drift, so a subsequent pointerup is a no-op
        // for onPress too (the gesture became a scroll, not a tap).
        act(() => {
            result.current.onPointerUp(pointerEvent({ pointerId: 1 }));
        });
        expect(onPress).not.toHaveBeenCalled();
    });

    it('ignores mouse pointers so desktop keeps its native click/right-click path', () => {
        const onLongPress = vi.fn();
        const onPress = vi.fn();
        const { result } = renderHook(() => useLongPress({ onLongPress, onPress }));

        act(() => {
            result.current.onPointerDown(pointerEvent({ pointerType: 'mouse' }));
            vi.advanceTimersByTime(500);
            result.current.onPointerUp(pointerEvent({ pointerType: 'mouse' }));
        });

        expect(onLongPress).not.toHaveBeenCalled();
        expect(onPress).not.toHaveBeenCalled();
    });

    it('disarms when a second finger lands (pinch / two-finger tap)', () => {
        const onLongPress = vi.fn();
        const { result } = renderHook(() => useLongPress({ onLongPress }));

        act(() => {
            result.current.onPointerDown(pointerEvent({ pointerId: 1 }));
            result.current.onPointerDown(pointerEvent({ pointerId: 2 }));
            vi.advanceTimersByTime(500);
        });

        expect(onLongPress).not.toHaveBeenCalled();
    });
});
