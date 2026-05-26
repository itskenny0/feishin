import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Popover } from '/@/shared/components/popover/popover';

/**
 * Regression for the fullscreen-player config shade. The shade is a CONTROLLED
 * Mantine Popover (`opened`/`onChange`) so it can be force-closed when the
 * visualizer expands. Mantine only auto-wires a click-to-toggle handler on the
 * target when the popover is UNcontrolled, so a controlled popover whose target
 * has no onClick can never be opened. The trigger must toggle the state itself.
 */
function ConfigShade({ wireOnClick }: { wireOnClick: boolean }) {
    const [opened, setOpened] = useState(false);
    // Mirror the real header: an effect can force-close, but only an explicit
    // toggle can open it.
    useEffect(() => {}, [opened]);
    return (
        <MantineProvider>
            <Popover onChange={setOpened} opened={opened} position="bottom">
                <Popover.Target>
                    <ActionIcon
                        aria-label="configure"
                        icon="settings2"
                        onClick={wireOnClick ? () => setOpened((o) => !o) : undefined}
                    />
                </Popover.Target>
                <Popover.Dropdown>content</Popover.Dropdown>
            </Popover>
        </MantineProvider>
    );
}

afterEach(cleanup);

describe('fullscreen config shade (controlled popover)', () => {
    it('stays closed on click when the trigger has no onClick wired (the bug)', () => {
        render(<ConfigShade wireOnClick={false} />);
        const trigger = screen.getByLabelText('configure');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        fireEvent.click(trigger);

        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens on click when the trigger toggles the controlled state (the fix)', () => {
        render(<ConfigShade wireOnClick />);
        const trigger = screen.getByLabelText('configure');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        fireEvent.click(trigger);

        expect(trigger.getAttribute('aria-expanded')).toBe('true');
    });
});
