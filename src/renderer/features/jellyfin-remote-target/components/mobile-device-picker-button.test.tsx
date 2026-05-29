import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useBottomSheetStore } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet-store';
import { MobileDevicePickerButton } from '/@/renderer/features/jellyfin-remote-target/components/mobile-device-picker-button';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

/**
 * Connect-related UI is hidden until the user has finished the Sync &
 * Connect setup wizard. The tests need the button to render, so we
 * pre-onboard before each test.
 */
const seedOnboarded = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            onboarded: true,
            ui: {
                connectButton: true,
                hideNonMqttDevices: false,
                pickerBadges: true,
                statusPill: true,
            },
        },
    });
};

const jellyfinServer: ServerListItemWithCredential = {
    credential: 'cred',
    id: 'srv-1',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'http://localhost',
    userId: 'user-1',
    username: 'demo',
};

const renderButton = () =>
    render(
        <MantineProvider>
            <MobileDevicePickerButton />
        </MantineProvider>,
    );

const openSheet = async (container: HTMLElement) => {
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
};

afterEach(() => {
    cleanup();
    useAuthStore.setState({ currentServer: null });
    // Drain any leftover bottom-sheet entries between tests.
    const sheetState = useBottomSheetStore.getState();
    for (const entry of [...sheetState.dismissStack]) {
        sheetState.remove(entry.id);
    }
});

describe('MobileDevicePickerButton', () => {
    it('renders a Connect trigger button when the current server is Jellyfin', () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        const button = container.querySelector('button');
        expect(button).not.toBeNull();
        // LuCast (remoteDevice) icon renders as an inline svg inside the button.
        expect(button?.querySelector('svg')).not.toBeNull();
    });

    it('opens the device sheet (drawer dialog) on click', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await openSheet(container);
    });

    it('renders nothing when there is no current server', () => {
        useAuthStore.setState({ currentServer: null });
        const { container } = renderButton();
        expect(container.querySelector('button')).toBeNull();
    });

    it('renders nothing for a non-Jellyfin server', () => {
        useAuthStore.setState({
            currentServer: { ...jellyfinServer, type: ServerType.NAVIDROME },
        });
        const { container } = renderButton();
        expect(container.querySelector('button')).toBeNull();
    });

    it('closes the sheet when the explicit close button (X) is clicked', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        await openSheet(container);

        const closeBtn = await screen.findByTestId('bottom-sheet-close');
        fireEvent.click(closeBtn);

        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('closes the sheet when the backdrop is tapped', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        await openSheet(container);

        const backdrop = await screen.findByTestId('bottom-sheet-backdrop');
        fireEvent.click(backdrop);

        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('closes the sheet on a downward swipe past the dismiss threshold', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        await openSheet(container);

        const sheet = await screen.findByTestId('bottom-sheet');

        // Simulate a strong downward pull starting at the sheet's top
        // edge. The component listens via native addEventListener so
        // dispatch a real TouchEvent rather than React's synthetic.
        const touchAt = (clientY: number, type: string) => {
            const evt = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent & {
                touches: Array<{ clientX: number; clientY: number }>;
            };
            (evt as unknown as { touches: unknown }).touches = [{ clientX: 100, clientY }];
            sheet.dispatchEvent(evt);
        };

        act(() => {
            touchAt(100, 'touchstart');
        });
        act(() => {
            touchAt(400, 'touchmove');
        });
        act(() => {
            touchAt(450, 'touchend');
        });

        await waitFor(
            () => {
                expect(document.querySelector('[role="dialog"]')).toBeNull();
            },
            { timeout: 1500 },
        );
    });

    it('closes the sheet when the Android back gesture fires (via dismissTop)', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        await openSheet(container);

        // The Android back handler calls dismissTop() on the
        // bottom-sheet store before walking the router history.
        let consumed = false;
        act(() => {
            consumed = useBottomSheetStore.getState().dismissTop();
        });
        expect(consumed).toBe(true);

        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('closes the sheet when the Escape key is pressed', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        await openSheet(container);

        fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });

        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    });

    it('locks body scroll while open and restores it on close', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        // Baseline: body has no inline overflow style.
        expect(document.body.style.overflow).toBe('');

        await openSheet(container);
        await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
        // Position:fixed pinning is what actually stops iOS Safari from
        // scrolling — verify we set it too, not just overflow:hidden.
        expect(document.body.style.position).toBe('fixed');

        fireEvent.click(await screen.findByTestId('bottom-sheet-close'));
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
        // Inline styles restored to empty.
        expect(document.body.style.overflow).toBe('');
        expect(document.body.style.position).toBe('');
    });

    it('returns focus to the trigger button after close', async () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        seedOnboarded();
        const { container } = renderButton();
        const trigger = container.querySelector('button') as HTMLButtonElement;
        trigger.focus();
        expect(document.activeElement).toBe(trigger);
        await openSheet(container);
        // While open, focus should be inside the dialog, not on the
        // trigger anymore — useFocusTrap pulls it in.
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog.contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
        await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
        // Focus restored to the original trigger.
        expect(document.activeElement).toBe(trigger);
    });
});
