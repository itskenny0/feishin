import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Track registrations + cleanups for the pragmatic-dnd element adapter.
const draggableCleanup = vi.fn();
const dropTargetCleanup = vi.fn();
const draggable = vi.fn((..._args: unknown[]) => draggableCleanup);
const dropTargetForElements = vi.fn((..._args: unknown[]) => dropTargetCleanup);

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
    draggable: (...args: unknown[]) => draggable(...args),
    dropTargetForElements: (...args: unknown[]) => dropTargetForElements(...args),
}));

// combine() in the real lib returns a single cleanup that calls every cleanup.
vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
    combine:
        (...cleanups: Array<() => void>) =>
        () =>
            cleanups.forEach((fn) => fn()),
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
    attachClosestEdge: (data: unknown) => data,
    extractClosestEdge: () => null,
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview', () => ({
    disableNativeDragPreview: vi.fn(),
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview', () => ({
    setCustomNativeDragPreview: vi.fn(),
}));

vi.mock('/@/renderer/components/drag-preview/drag-preview', () => ({
    DragPreview: () => null,
}));

vi.mock('/@/shared/types/drag-and-drop', () => ({
    dndUtils: {
        generateDragData: (args: unknown) => args,
    },
    DragOperation: { ADD: 'add', REORDER: 'reorder' },
    DragTarget: { ALBUM: 'album', GENERIC: 'generic' },
}));

vi.mock('/@/shared/types/domain-types', () => ({
    LibraryItem: { ALBUM: 'album', SONG: 'song' },
}));

// Import after mocks are registered.
const { useDragDrop } = await import('./use-drag-drop');

const makeDrag = (id = ['1']) => ({
    getId: () => id,
    getItem: () => [{ id: id[0] }],
    operation: ['add'],
    target: 'album',
});

interface HarnessProps {
    drag?: ReturnType<typeof makeDrag>;
    isEnabled: boolean;
}

const Harness = ({ drag, isEnabled }: HarnessProps) => {
    const { ref } = useDragDrop<HTMLDivElement>({ drag: drag as never, isEnabled });
    return <div data-testid="row" ref={ref} />;
};

describe('useDragDrop registration stability', () => {
    beforeEach(() => {
        draggable.mockClear();
        dropTargetForElements.mockClear();
        draggableCleanup.mockClear();
        dropTargetCleanup.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers the draggable exactly once per element mount', () => {
        render(<Harness drag={makeDrag()} isEnabled />);
        expect(draggable).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-register when an unrelated re-render passes a new drag object identity', () => {
        const { rerender } = render(<Harness drag={makeDrag(['1'])} isEnabled />);
        expect(draggable).toHaveBeenCalledTimes(1);

        // A fresh drag config object on every render (the pre-fix churn case) must
        // NOT tear down + re-register, because internals are read via refs.
        rerender(<Harness drag={makeDrag(['1'])} isEnabled />);
        rerender(<Harness drag={makeDrag(['2'])} isEnabled />);

        expect(draggable).toHaveBeenCalledTimes(1);
        expect(draggableCleanup).not.toHaveBeenCalled();
    });

    it('reads the latest drag config via refs (lazy getInitialData)', () => {
        const { rerender } = render(<Harness drag={makeDrag(['first'])} isEnabled />);
        const firstCall = draggable.mock.calls[0][0] as { getInitialData: () => unknown };

        rerender(<Harness drag={makeDrag(['second'])} isEnabled />);

        // Same registration, but lazily evaluating now reflects the latest config.
        expect(draggable).toHaveBeenCalledTimes(1);
        expect(firstCall.getInitialData()).toMatchObject({ id: ['second'] });
    });

    it('cleans up the registration on unmount', () => {
        const { unmount } = render(<Harness drag={makeDrag()} isEnabled />);
        expect(draggableCleanup).not.toHaveBeenCalled();
        unmount();
        expect(draggableCleanup).toHaveBeenCalledTimes(1);
    });

    it('does not register while disabled, then registers when enabled', () => {
        const { rerender } = render(<Harness drag={makeDrag()} isEnabled={false} />);
        expect(draggable).not.toHaveBeenCalled();

        rerender(<Harness drag={makeDrag()} isEnabled />);
        expect(draggable).toHaveBeenCalledTimes(1);
    });
});
