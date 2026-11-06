import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/remote/components/action-sheet', () => ({
    ActionSheet: ({ children, onClose, opened }: any) =>
        opened ? (
            <div>
                <button onClick={onClose}>dismiss</button>
                {children}
            </div>
        ) : null,
}));
vi.mock('/@/shared/components/button/button', () => ({
    Button: ({ children, disabled, loading, onClick }: any) => (
        <button data-loading={String(Boolean(loading))} disabled={disabled} onClick={onClick}>
            {children}
        </button>
    ),
}));
vi.mock('/@/shared/components/group/group', () => ({ Group: ({ children }: any) => children }));
vi.mock('/@/shared/components/stack/stack', () => ({ Stack: ({ children }: any) => children }));
vi.mock('/@/shared/components/text/text', () => ({ Text: ({ children }: any) => children }));

import { QueueReplaceConfirmSheet } from './queue-replace-confirm-sheet';

import { useRemoteLibraryStore } from '/@/remote/store/library';

describe('QueueReplaceConfirmSheet', () => {
    it('a confirm that settles after the sheet was dismissed leaves a newer request alone', async () => {
        let settleFirst = () => {};
        const first = {
            cancel: vi.fn(),
            execute: vi.fn(() => new Promise<void>((resolve) => (settleFirst = resolve))),
        };
        const second = { cancel: vi.fn(), execute: vi.fn(async () => {}) };
        const { actions } = useRemoteLibraryStore.getState();

        act(() => actions.requestQueueReplaceConfirm(first));
        render(<QueueReplaceConfirmSheet />);
        fireEvent.click(screen.getByText('Confirm'));
        // Swiped away while the first send is still waiting on its ack, then
        // the user taps another row that asks again.
        fireEvent.click(screen.getByText('dismiss'));
        act(() => actions.requestQueueReplaceConfirm(second));
        expect(screen.getByText('Confirm').dataset.loading).toBe('false');

        await act(async () => settleFirst());

        expect(useRemoteLibraryStore.getState().queueReplaceConfirm).toBe(second);
        expect(second.cancel).not.toHaveBeenCalled();
        expect(screen.getByText('Confirm')).toBeInTheDocument();
    });
});
