import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WindowSettings gates every control behind isElectron() and reads
// window.api.{utils,localSettings}. The settings store *also* reads
// window.api.utils at module-init, so the stub must exist before any import
// that pulls the store in. vi.hoisted runs before the hoisted mocks/imports.
vi.hoisted(() => {
    const g = globalThis as unknown as { window?: { api?: unknown } };
    g.window = g.window ?? {};
    g.window.api = {
        localSettings: { set: () => {} },
        utils: {
            isLinux: () => false,
            isMacOS: () => false,
            isWindows: () => true,
        },
    };
});

vi.mock('is-electron', () => ({ default: () => true }));

import { WindowSettings } from '/@/renderer/features/settings/components/window/window-settings';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seedTray = (tray: boolean, minimizeToTray: boolean) => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        window: { ...prev.window, minimizeToTray, tray },
    });
};

const renderWindowSettings = () =>
    render(
        <MantineProvider>
            <WindowSettings />
        </MantineProvider>,
    );

describe('WindowSettings minimize-to-tray binding', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        // Tray must be on for the minimize/exit/start switches to be visible.
        seedTray(true, false);
    });

    it('reflects minimizeToTray (not tray) in the minimize-to-tray switch', () => {
        // tray=true but minimizeToTray=false -> the control must render UNCHECKED.
        // Under the old bug it read settings.tray and rendered checked.
        renderWindowSettings();

        const minimizeSwitch = screen.getByLabelText('Toggle minimize to tray') as HTMLInputElement;
        expect(minimizeSwitch.checked).toBe(false);
    });

    it('renders the minimize-to-tray switch checked when minimizeToTray is true', () => {
        seedTray(true, true);
        renderWindowSettings();

        const minimizeSwitch = screen.getByLabelText('Toggle minimize to tray') as HTMLInputElement;
        expect(minimizeSwitch.checked).toBe(true);
    });
});
