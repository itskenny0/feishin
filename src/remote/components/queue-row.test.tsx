import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/remote/components/list-row', () => ({
    ListRow: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('/@/remote/components/thumbnail', () => ({ Thumbnail: () => null }));
vi.mock('/@/shared/components/icon/icon', () => ({
    Icon: ({ icon }: { icon: string }) => <i data-icon={icon} />,
}));
vi.mock('/@/shared/components/stack/stack', () => ({ Stack: ({ children }: any) => children }));
vi.mock('/@/shared/components/text/text', () => ({ Text: ({ children }: any) => children }));

import { QueueRow } from './queue-row';

describe('QueueRow drag handle', () => {
    it('a tap without movement does not leave a reorder drag in progress', async () => {
        const dragReorder = {
            draggingId: null,
            dropTarget: null,
            endDrag: vi.fn(),
            startDrag: vi.fn(),
            updateDrag: vi.fn(),
        };
        const onReorderDragStart = vi.fn();
        const { container } = render(
            <QueueRow
                ariaAttributes={{} as never}
                currentUniqueId={null}
                dragReorder={dragReorder}
                index={0}
                items={[{ duration: 1, id: 'a', name: 'A', uniqueId: 'ua' } as never]}
                onJump={vi.fn()}
                onLongPress={vi.fn()}
                onRemove={vi.fn()}
                onReorderDragStart={onReorderDragStart}
                style={{}}
            />,
        );

        // motion only fires onDragEnd (-> endDrag) once a pan actually
        // started, so whatever a tap begins is never ended: the queue page
        // then ignores every server queue broadcast until the next drag.
        const handle = container.querySelector('[data-icon="dragVertical"]')!;
        fireEvent.pointerDown(handle, { button: 0, clientX: 5, clientY: 5, isPrimary: true });
        fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5, isPrimary: true });
        await new Promise((r) => setTimeout(r, 50));

        expect(dragReorder.endDrag).not.toHaveBeenCalled();
        expect(onReorderDragStart).not.toHaveBeenCalled();
        expect(dragReorder.startDrag).not.toHaveBeenCalled();

        // An actual drag still starts and ends the reorder.
        fireEvent.pointerDown(handle, { button: 0, clientX: 5, clientY: 5, isPrimary: true });
        fireEvent.pointerMove(window, { button: 0, clientX: 5, clientY: 60, isPrimary: true });
        await vi.waitFor(() => expect(dragReorder.startDrag).toHaveBeenCalledWith('ua', 0));
        expect(onReorderDragStart).toHaveBeenCalledTimes(1);
        fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 60, isPrimary: true });
        await vi.waitFor(() => expect(dragReorder.endDrag).toHaveBeenCalledWith('ua'));
    });
});
