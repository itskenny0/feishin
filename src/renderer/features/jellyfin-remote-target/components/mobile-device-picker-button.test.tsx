import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MobileDevicePickerButton } from '/@/renderer/features/jellyfin-remote-target/components/mobile-device-picker-button';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

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

afterEach(() => {
    cleanup();
    useAuthStore.setState({ currentServer: null });
});

describe('MobileDevicePickerButton', () => {
    it('renders a Connect trigger button when the current server is Jellyfin', () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        const { container } = renderButton();
        const button = container.querySelector('button');
        expect(button).not.toBeNull();
        // LuCast (remoteDevice) icon renders as an inline svg inside the button.
        expect(button?.querySelector('svg')).not.toBeNull();
    });

    it('toggles the picker open on click (controlled popover)', () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        const { container } = renderButton();
        const button = container.querySelector('button') as HTMLButtonElement;
        // Mantine sets aria-expanded on the Popover.Target wrapper, not the button.
        expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
            'false',
        );
        fireEvent.click(button);
        expect(container.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
            'true',
        );
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
});
