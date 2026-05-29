import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsLayout } from '/@/renderer/features/settings/components/settings-layout';
import { useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * Force / unforce the mobile shell. `useIsMobileShell` is
 * `matchMedia(MOBILE_SHELL_QUERY) || general.mobileShellForce`; jsdom's
 * matchMedia always reports no-match, so the force flag is the test handle.
 */
const setMobileShell = (force: boolean) => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        general: { ...prev.general, mobileShellForce: force },
    });
};

const seedDrilldown = (tab: string, tabSubpage: string) => {
    useSettingsStore.getState().actions.setSettings({ tab, tabSubpage });
};

const renderLayout = () =>
    render(
        <MantineProvider>
            <SettingsLayout />
        </MantineProvider>,
    );

describe('SettingsLayout drill-down retention', () => {
    beforeEach(() => {
        // Reset to a known drilled-in state before each case.
        seedDrilldown('general', '');
        setMobileShell(false);
    });

    afterEach(() => {
        cleanup();
        seedDrilldown('general', '');
        setMobileShell(false);
    });

    it('on mobile, entering Settings drops any retained subpage and lands on the category list', () => {
        setMobileShell(true);
        seedDrilldown('general', 'theme');

        renderLayout();

        const state = useSettingsStore.getState();
        expect(state.tabSubpage).toBe('');
        expect(state.tab).toBe('');
    });

    it('on desktop, the retained tab/subpage are preserved (category rail is always visible)', () => {
        setMobileShell(false);
        seedDrilldown('general', 'theme');

        renderLayout();

        const state = useSettingsStore.getState();
        expect(state.tab).toBe('general');
        expect(state.tabSubpage).toBe('theme');
    });
});
