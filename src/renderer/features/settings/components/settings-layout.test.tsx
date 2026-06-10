import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SettingsLayout } from '/@/renderer/features/settings/components/settings-layout';
import { SETTINGS_SUBPAGES } from '/@/renderer/features/settings/subpages';
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

describe('SettingsLayout category structure', () => {
    beforeEach(() => {
        seedDrilldown('general', '');
        setMobileShell(false);
    });

    afterEach(() => {
        cleanup();
        seedDrilldown('general', '');
        setMobileShell(false);
    });

    it('exposes the expanded top-level categories (Appearance / Home page / Library)', () => {
        renderLayout();

        // The General category was split; these labels render in the rail.
        // getAllByText: the active category's label ALSO renders as the page
        // watermark, so the same string can legitimately appear twice.
        expect(screen.getAllByText('Appearance').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Home page').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Library').length).toBeGreaterThanOrEqual(1);
    });

    it('keeps every subpage reachable under exactly one top-level category', () => {
        // No subpage id should be registered under two categories at once, and
        // the manifest must include the new home/library buckets.
        expect(SETTINGS_SUBPAGES.home.map((s) => s.id)).toContain('home');
        expect(SETTINGS_SUBPAGES.library.map((s) => s.id)).toEqual(
            expect.arrayContaining(['scrobble', 'lyrics', 'artist', 'paths', 'query-builder']),
        );

        const seen = new Set<string>();
        for (const [category, subpages] of Object.entries(SETTINGS_SUBPAGES)) {
            for (const sub of subpages) {
                const key = `${category}:${sub.id}`;
                expect(seen.has(key)).toBe(false);
                seen.add(key);
            }
        }
    });

    it('search finds a subpage that moved categories (Scrobbling → Library)', () => {
        renderLayout();

        const input = screen.getByLabelText('Search settings');
        fireEvent.change(input, { target: { value: 'scrobb' } });

        // Hit list shows the subpage label + its (new) category crumb. The
        // real i18n key renders "Scrobble" (the defaultValue is unused).
        expect(screen.getAllByText('Scrobble').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Library').length).toBeGreaterThanOrEqual(1);
    });

    it('hides drill-down child subpages from search (e.g. Artwork variants)', () => {
        renderLayout();

        const input = screen.getByLabelText('Search settings');
        fireEvent.change(input, { target: { value: 'artwork' } });

        // image-variants has a `parent`, so it never surfaces as its own hit.
        expect(screen.queryByText('Artwork variants')).not.toBeInTheDocument();
    });

    it('registers the Artwork variants editor as a child of Library sync', () => {
        const child = SETTINGS_SUBPAGES.connect.find((s) => s.id === 'image-variants');
        expect(child?.parent).toBe('library-sync');
    });
});
