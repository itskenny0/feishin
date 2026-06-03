import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useBottomSheetStore } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet-store';
import { MyLibraryPopover } from '/@/renderer/layouts/mobile-layout/my-library-popover';
import { sidebarItems, useSettingsStore } from '/@/renderer/store/settings.store';

/**
 * The popover sources its entries from the shared `useSidebarItems()`
 * store slice. Seed the canonical default list so the test asserts against
 * the same set the sidebar shows.
 */
const seedSidebarItems = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        general: { ...prev.general, sidebarItems },
    });
};

// A tiny probe that surfaces the current pathname so we can assert that
// selecting an entry actually navigates.
const LocationProbe = () => {
    const location = useLocation();
    return <div data-testid="pathname">{location.pathname}</div>;
};

// Host that owns the open/close state, the way the bottom tab bar does.
const Harness = () => {
    const [opened, setOpened] = useState(true);
    return (
        <MantineProvider>
            <MemoryRouter initialEntries={['/']}>
                <LocationProbe />
                <MyLibraryPopover onClose={() => setOpened(false)} opened={opened} />
                <Routes>
                    <Route element={<div>home</div>} path="/" />
                    <Route element={<div>albums</div>} path="/library/albums" />
                </Routes>
            </MemoryRouter>
        </MantineProvider>
    );
};

beforeEach(() => {
    seedSidebarItems();
});

afterEach(() => {
    cleanup();
    // Drain any leftover bottom-sheet dismiss entries between tests.
    const sheetState = useBottomSheetStore.getState();
    for (const entry of [...sheetState.dismissStack]) {
        sheetState.remove(entry.id);
    }
});

describe('MyLibraryPopover', () => {
    it('renders the bottom-sheet dialog when opened', async () => {
        render(<Harness />);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    });

    it('lists the library entity entries mirrored from the sidebar', async () => {
        render(<Harness />);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

        // The enabled, routed, non-Collections entries from the default
        // sidebar item list — i.e. exactly what the sidebar's "My Library"
        // section shows.
        expect(screen.getByTestId('my-library-entry-Albums')).toBeTruthy();
        expect(screen.getByTestId('my-library-entry-Tracks')).toBeTruthy();
        expect(screen.getByTestId('my-library-entry-Favorites')).toBeTruthy();
        expect(screen.getByTestId('my-library-entry-Artists')).toBeTruthy();
        expect(screen.getByTestId('my-library-entry-Genres')).toBeTruthy();
        expect(screen.getByTestId('my-library-entry-Folders')).toBeTruthy();

        // Playlists is `disabled` in the default sidebar list because the
        // desktop sidebar shows it via a dedicated playlist-tree section.
        // Mobile has no such section, so the popover must still surface it.
        expect(screen.getByTestId('my-library-entry-Playlists')).toBeTruthy();

        // Collections has no route → never rendered.
        expect(screen.queryByTestId('my-library-entry-Collections')).toBeNull();
        // Disabled-by-default navigation entries (not library sections) stay
        // filtered out.
        expect(screen.queryByTestId('my-library-entry-Settings')).toBeNull();
        expect(screen.queryByTestId('my-library-entry-Search')).toBeNull();
    });

    it('navigates to the entry route and closes the popover on selection', async () => {
        render(<Harness />);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
        expect(screen.getByTestId('pathname').textContent).toBe('/');

        fireEvent.click(screen.getByTestId('my-library-entry-Albums'));

        // Navigated to the Albums route…
        await waitFor(() =>
            expect(screen.getByTestId('pathname').textContent).toBe('/library/albums'),
        );
        // …and the sheet closed.
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('renders nothing (no dialog) while closed', () => {
        render(
            <MantineProvider>
                <MemoryRouter>
                    <MyLibraryPopover onClose={() => undefined} opened={false} />
                </MemoryRouter>
            </MantineProvider>,
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('closes when the backdrop is tapped', async () => {
        render(<Harness />);
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

        fireEvent.click(await screen.findByTestId('bottom-sheet-backdrop'));
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });
});
