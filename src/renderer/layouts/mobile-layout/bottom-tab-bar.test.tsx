import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBottomSheetStore } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet-store';
import { BottomTabBar } from '/@/renderer/layouts/mobile-layout/bottom-tab-bar';
import { sidebarItems, useSettingsStore } from '/@/renderer/store/settings.store';

const seedSidebarItems = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        general: { ...prev.general, sidebarItems },
    });
};

const renderBar = (props: Partial<Parameters<typeof BottomTabBar>[0]> = {}, route = '/') =>
    render(
        <MantineProvider>
            <MemoryRouter initialEntries={[route]}>
                <BottomTabBar {...props} />
            </MemoryRouter>
        </MantineProvider>,
    );

// Find a nav button by its accessible label (the translated label, which
// falls back to the defaultValue we pass at the call site). The tab bar uses
// plain nav buttons (not ARIA tabs) since they navigate routes / toggle a menu
// rather than control tabpanels.
const tab = (label: RegExp) =>
    screen.getAllByRole('button').find((b) => label.test(b.getAttribute('aria-label') ?? ''));

beforeEach(() => {
    seedSidebarItems();
    // Stub vibrate so the haptic call path is exercised without jsdom
    // complaining about a missing navigator API.
    Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: vi.fn(),
        writable: true,
    });
});

afterEach(() => {
    cleanup();
    const sheetState = useBottomSheetStore.getState();
    for (const entry of [...sheetState.dismissStack]) {
        sheetState.remove(entry.id);
    }
    vi.restoreAllMocks();
});

describe('BottomTabBar — My Library tab', () => {
    it('does not open the popover until the Library tab is tapped', () => {
        renderBar();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('opens the My Library popover (bottom sheet) when the Library tab is tapped', async () => {
        renderBar();
        const libraryTab = tab(/library/i);
        expect(libraryTab).toBeTruthy();

        fireEvent.click(libraryTab as HTMLElement);

        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
        // The popover lists the mirrored sidebar library entries.
        expect(screen.getByTestId('my-library-entry-Albums')).toBeTruthy();
        expect(screen.getByTestId('my-library-entry-Genres')).toBeTruthy();
    });

    it('fires a haptic when the Library tab is tapped', () => {
        renderBar();
        fireEvent.click(tab(/library/i) as HTMLElement);
        expect(navigator.vibrate).toHaveBeenCalled();
    });

    it('selecting an entry navigates and closes the popover', async () => {
        renderBar();
        fireEvent.click(tab(/library/i) as HTMLElement);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

        fireEvent.click(screen.getByTestId('my-library-entry-Albums'));
        // The sheet closes after navigation.
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('does not call onScrollToTop when re-tapping the Library tab (it toggles the popover instead)', async () => {
        const onScrollToTop = vi.fn();
        renderBar({ onScrollToTop });
        fireEvent.click(tab(/library/i) as HTMLElement);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
        expect(onScrollToTop).not.toHaveBeenCalled();
    });
});

describe('BottomTabBar — active indicator', () => {
    const dots = () => screen.queryAllByTestId('bottom-tab-active-dot');

    it('renders exactly one active dot for a plain route', () => {
        renderBar({}, '/');
        expect(dots()).toHaveLength(1);
    });

    it('no longer renders a More/Menu tab (moved into the Settings view)', () => {
        renderBar({}, '/');
        expect(tab(/more|menu/i)).toBeUndefined();
    });

    it('moves the dot to the Library tab when its popover is open over the Home route', async () => {
        renderBar({}, '/');
        fireEvent.click(tab(/library/i) as HTMLElement);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
        expect(dots()).toHaveLength(1);
        expect(tab(/library/i)?.contains(dots()[0])).toBe(true);
    });
});
