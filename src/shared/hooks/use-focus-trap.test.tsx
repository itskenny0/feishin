import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFocusTrap } from '/@/shared/hooks/use-focus-trap';

/**
 * Reproduction for the login-wizard focus-steal bug. Mantine's useFocusTrap
 * re-runs focusNode() (focusing `[data-autofocus]`) whenever its ref callback
 * is detached + re-attached. React re-attaches a callback ref on every render
 * when the callback's identity changes — so an *inline* ref callback steals
 * focus back to the first field on every keystroke, while a *memoized* one
 * attaches once and leaves focus alone.
 */
function Harness({ stable }: { stable: boolean }) {
    const focusTrapRef = useFocusTrap(true);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [, setTick] = useState(0);

    const stableSetRef = useCallback(
        (node: HTMLDivElement | null) => {
            containerRef.current = node;
            focusTrapRef(node);
        },
        [focusTrapRef],
    );
    const inlineSetRef = (node: HTMLDivElement | null) => {
        containerRef.current = node;
        focusTrapRef(node);
    };

    return (
        <div ref={stable ? stableSetRef : inlineSetRef}>
            <input data-autofocus data-testid="first" />
            <input data-testid="second" onChange={() => setTick((t) => t + 1)} />
        </div>
    );
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('useFocusTrap ref stability (login wizard focus-steal)', () => {
    it('inline ref callback steals focus back to [data-autofocus] on re-render (the bug)', () => {
        vi.useFakeTimers();
        render(<Harness stable={false} />);
        vi.runAllTimers(); // initial autofocus settles on the first field

        const second = screen.getByTestId('second') as HTMLInputElement;
        second.focus();
        expect(document.activeElement).toBe(second);

        fireEvent.change(second, { target: { value: 'a' } }); // re-render → ref churn
        vi.runAllTimers();

        expect(document.activeElement).toBe(screen.getByTestId('first')); // focus stolen
    });

    it('memoized ref callback keeps focus in the typed field on re-render (the fix)', () => {
        vi.useFakeTimers();
        render(<Harness stable />);
        vi.runAllTimers();

        const second = screen.getByTestId('second') as HTMLInputElement;
        second.focus();

        fireEvent.change(second, { target: { value: 'a' } });
        vi.runAllTimers();

        expect(document.activeElement).toBe(second); // focus retained
    });
});
