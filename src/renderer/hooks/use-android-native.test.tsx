import { MantineProvider, Modal, Popover } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissDomOverlayForBack } from '/@/renderer/hooks/use-android-native';

/**
 * The Android back gesture closes DOM-rendered overlays by synthesising an
 * Escape keydown. These pin the two ways that used to fall through to
 * history.back() (or exit the app) while an overlay was open.
 */

afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
});

const addMenu = (state: 'closed' | 'open') => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    const content = document.createElement('div');
    content.setAttribute('data-radix-menu-content', '');
    content.setAttribute('data-state', state);
    wrapper.appendChild(content);
    document.body.appendChild(wrapper);
};

describe('dismissDomOverlayForBack', () => {
    it('consumes the press for an open Radix menu even though its wrapper outlives the close', () => {
        addMenu('open');
        const onEscape = vi.fn();
        document.addEventListener('keydown', onEscape);

        expect(dismissDomOverlayForBack()).toBe(true);
        expect(onEscape).toHaveBeenCalledTimes(1);
        expect((onEscape.mock.calls[0][0] as KeyboardEvent).key).toBe('Escape');

        document.removeEventListener('keydown', onEscape);
    });

    it('does not consume the press for a menu that is only finishing its exit animation', () => {
        addMenu('closed');
        expect(dismissDomOverlayForBack()).toBe(false);
    });

    it('closes an open Mantine modal and consumes the press', () => {
        const onClose = vi.fn();
        render(
            <MantineProvider>
                <Modal
                    onClose={onClose}
                    opened
                    title="Add to playlist"
                    transitionProps={{ duration: 0 }}
                >
                    body
                </Modal>
            </MantineProvider>,
        );
        // Page-level Escape hotkeys (Mantine useHotkeys binds on <html>, e.g.
        // the fullscreen player's minimise) must not fire for the same press.
        const pageHotkey = vi.fn();
        document.documentElement.addEventListener('keydown', pageHotkey);

        expect(dismissDomOverlayForBack()).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(pageHotkey).not.toHaveBeenCalled();

        document.documentElement.removeEventListener('keydown', pageHotkey);
    });

    it('closes an open Mantine popover (e.g. the sleep timer) and consumes the press', () => {
        // Controlled like the sleep timer: closing reports onChange(false).
        const onChange = vi.fn();
        render(
            <MantineProvider>
                <Popover onChange={onChange} opened transitionProps={{ duration: 0 }}>
                    <Popover.Target>
                        <button type="button">sleep timer</button>
                    </Popover.Target>
                    <Popover.Dropdown>presets</Popover.Dropdown>
                </Popover>
            </MantineProvider>,
        );

        expect(dismissDomOverlayForBack()).toBe(true);
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it('returns false and still dispatches Escape to document listeners when nothing is open', () => {
        const onEscape = vi.fn();
        document.addEventListener('keydown', onEscape);

        expect(dismissDomOverlayForBack()).toBe(false);
        // Bottom sheets and other document-level closers keep receiving it.
        expect(onEscape).toHaveBeenCalledTimes(1);

        document.removeEventListener('keydown', onEscape);
    });
});
