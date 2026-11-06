// @vitest-environment node
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    shell: { openExternal: vi.fn() },
}));

import MenuBuilder from './menu';

const findItem = (
    items: MenuItemConstructorOptions[],
    label: string,
): MenuItemConstructorOptions | undefined => {
    for (const item of items) {
        if (item.label === label) return item;
        if (Array.isArray(item.submenu)) {
            const found = findItem(item.submenu, label);
            if (found) return found;
        }
    }
    return undefined;
};

const click = (item: MenuItemConstructorOptions | undefined) => (item?.click as () => void)();

describe('MenuBuilder (macOS application menu)', () => {
    it('sends menu actions to the window that is current at click time', () => {
        const destroyedSend = vi.fn(() => {
            throw new Error('Object has been destroyed');
        });
        const reopenedSend = vi.fn();
        let current: BrowserWindow | null = {
            webContents: { send: destroyedSend },
        } as unknown as BrowserWindow;

        const template = new MenuBuilder(() => current, vi.fn()).buildDarwinTemplate();

        // Window closed: the app (and its menu) stays alive on macOS.
        current = null;
        expect(() => click(findItem(template, 'Settings...'))).not.toThrow();
        expect(() => click(findItem(template, 'Next'))).not.toThrow();
        expect(destroyedSend).not.toHaveBeenCalled();

        // Window re-created from the dock: the same menu now reaches it.
        current = { webContents: { send: reopenedSend } } as unknown as BrowserWindow;
        click(findItem(template, 'Settings...'));
        expect(reopenedSend).toHaveBeenCalledWith('renderer-open-settings');
    });
});
