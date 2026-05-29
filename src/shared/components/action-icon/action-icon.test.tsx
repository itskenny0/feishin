/**
 * Accessibility regression coverage for ActionIcon.
 *
 * A Mantine Tooltip only sets aria-describedby while hovered/focused; it does
 * not give the wrapped button an accessible name. ~100 icon-only buttons
 * app-wide pass only `tooltip` with no `aria-label`, so to a screen reader
 * they were unlabeled "button"s. ActionIcon now forwards a string tooltip
 * label to aria-label when no explicit aria-label is supplied.
 *
 * These tests lock in:
 *   - tooltip-only icon button gets aria-label from the tooltip label
 *   - an explicit aria-label always wins over the tooltip label
 *   - a non-string (ReactNode) tooltip label does NOT become an aria-label
 *   - no tooltip + no aria-label => no aria-label attribute is invented
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionIcon } from '/@/shared/components/action-icon/action-icon';

const renderWithProvider = (ui: React.ReactElement) =>
    render(<MantineProvider>{ui}</MantineProvider>);

afterEach(() => {
    cleanup();
});

describe('ActionIcon accessible name', () => {
    it('forwards a string tooltip label to aria-label when none is supplied', () => {
        renderWithProvider(<ActionIcon icon="mediaPlay" tooltip={{ label: 'Play' }} />);
        expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    });

    it('prefers an explicit aria-label over the tooltip label', () => {
        renderWithProvider(
            <ActionIcon
                aria-label="Resume playback"
                icon="mediaPlay"
                tooltip={{ label: 'Play' }}
            />,
        );
        expect(screen.getByRole('button', { name: 'Resume playback' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    });

    it('does not derive an aria-label from a non-string tooltip label', () => {
        renderWithProvider(<ActionIcon icon="mediaPlay" tooltip={{ label: <span>Play</span> }} />);
        // The button has no accessible name (the ReactNode label is not a
        // string, so it cannot be safely flattened into aria-label).
        expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
        const button = screen.getByRole('button');
        expect(button.getAttribute('aria-label')).toBeNull();
    });

    it('invents no aria-label when neither tooltip nor aria-label is given', () => {
        renderWithProvider(<ActionIcon icon="mediaPlay" />);
        const button = screen.getByRole('button');
        expect(button.getAttribute('aria-label')).toBeNull();
    });

    it('labels a children-only tooltip button (no icon) from the tooltip label', () => {
        renderWithProvider(
            <ActionIcon tooltip={{ label: 'Settings' }}>
                <span aria-hidden>Gear</span>
            </ActionIcon>,
        );
        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    });
});
