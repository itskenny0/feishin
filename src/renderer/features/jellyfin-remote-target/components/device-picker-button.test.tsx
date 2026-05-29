/**
 * Coverage for the desktop Connect button.
 *
 * Sync & Connect audit:
 *   - F3: the accessible name carries the connected device name.
 *   - F4: the 'offline' status is dead UI — removing its yellow-tint branch
 *     must not change rendering for real states.
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DevicePickerButton } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-button';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
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

const seedOnboarded = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            jellyfinRemoteEnabled: true,
            onboarded: true,
            ui: {
                ...prev.peerSync.ui,
                connectButton: true,
                statusPill: true,
            },
        },
    });
};

const renderButton = () =>
    render(
        <MantineProvider>
            <DevicePickerButton />
        </MantineProvider>,
    );

beforeEach(() => {
    useAuthStore.setState({ currentServer: jellyfinServer });
    seedOnboarded();
    useRemoteTargetStore.getState().actions.clearTarget();
});

afterEach(() => {
    cleanup();
    useAuthStore.setState({ currentServer: null });
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('DevicePickerButton', () => {
    it('renders the cast button when the server is Jellyfin and onboarded', () => {
        const { container } = renderButton();
        expect(container.querySelector('button')).not.toBeNull();
    });

    it('uses a dynamic aria-label carrying the device name when remote (F3)', () => {
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Living Room TV',
            sessionId: 'sess-1',
        });
        const { container } = renderButton();
        const button = container.querySelector('button') as HTMLButtonElement;
        expect(button.getAttribute('aria-label')).toContain('Living Room TV');
    });

    it('falls back to the static "Listen on" aria-label when not remote (F3)', () => {
        const { container } = renderButton();
        const button = container.querySelector('button') as HTMLButtonElement;
        const label = button.getAttribute('aria-label') ?? '';
        expect(label).not.toContain('Living Room TV');
        expect(label.length).toBeGreaterThan(0);
    });

    it('still renders normally when status is the dead offline value (F4)', () => {
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Living Room TV',
            sessionId: 'sess-1',
        });
        // 'offline' has no producer; the tint branch was removed. The button
        // must still render and stay accessible.
        useRemoteTargetStore.getState().actions.setStatus('offline');
        const { container } = renderButton();
        const button = container.querySelector('button') as HTMLButtonElement;
        expect(button).not.toBeNull();
        expect(button.getAttribute('aria-label')).toContain('Living Room TV');
    });
});
