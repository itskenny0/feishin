/**
 * Coverage for the persistent remote-status banner.
 *
 * Sync & Connect audit F4: the banner must render for the two degraded /
 * in-flight states that actually have producers — 'reconnecting'
 * (sessions-poller missing-target ladder) and 'transferring' (connect
 * lifecycle handoff) — and stay silent for everything else, including the
 * dead 'offline' state that no controller ever sets.
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RemoteStatusBanner } from '/@/renderer/features/jellyfin-remote-target/components/remote-status-banner';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seedOnboarded = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            jellyfinRemoteEnabled: true,
            onboarded: true,
        },
    });
};

const seedTarget = () =>
    useRemoteTargetStore.getState().actions.setTarget({
        capabilities: [],
        deviceId: 'dev-1',
        deviceName: 'Living Room TV',
        sessionId: 'sess-1',
    });

const renderBanner = () =>
    render(
        <MantineProvider>
            <RemoteStatusBanner />
        </MantineProvider>,
    );

beforeEach(() => {
    seedOnboarded();
    useRemoteTargetStore.getState().actions.clearTarget();
});

afterEach(() => {
    cleanup();
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('RemoteStatusBanner', () => {
    it('renders the reconnecting banner with the device name', () => {
        seedTarget();
        useRemoteTargetStore.getState().actions.setStatus('reconnecting');
        renderBanner();
        expect(screen.getByText(/Reconnecting to Living Room TV/i)).not.toBeNull();
    });

    it('renders a transferring banner with the device name (F4)', () => {
        seedTarget();
        useRemoteTargetStore.getState().actions.setStatus('transferring');
        renderBanner();
        expect(screen.getByText(/Transferring playback to Living Room TV/i)).not.toBeNull();
    });

    it('renders nothing for a connected target', () => {
        seedTarget();
        useRemoteTargetStore.getState().actions.setStatus('connected');
        const { container } = renderBanner();
        // Only the MantineProvider style tag — no banner div.
        expect(container.querySelector('.mantine-Loader-root')).toBeNull();
        expect(screen.queryByText(/Living Room TV/i)).toBeNull();
    });

    it('renders nothing for the dead offline state (F4 — no producer)', () => {
        seedTarget();
        useRemoteTargetStore.getState().actions.setStatus('offline');
        const { container } = renderBanner();
        expect(container.querySelector('.mantine-Loader-root')).toBeNull();
        expect(screen.queryByText(/Living Room TV/i)).toBeNull();
    });

    it('renders nothing when peer sync is not onboarded even while reconnecting', () => {
        const prev = useSettingsStore.getState();
        useSettingsStore.setState({
            ...prev,
            peerSync: { ...prev.peerSync, onboarded: false },
        });
        seedTarget();
        useRemoteTargetStore.getState().actions.setStatus('reconnecting');
        const { container } = renderBanner();
        expect(container.querySelector('.mantine-Loader-root')).toBeNull();
    });
});
