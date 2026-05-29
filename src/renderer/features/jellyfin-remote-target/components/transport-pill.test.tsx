/**
 * Visibility-gate regression coverage for the player-bar transport pill.
 *
 * The pill is a Connect-related chrome element. Per the Sync & Connect
 * audit, it must stay hidden when any of:
 *   - the user hasn't finished the wizard (`onboarded=false`)
 *   - the master kill-switch is off (`jellyfinRemoteEnabled=false`)
 *   - the per-element toggle is off (`ui.statusPill=false`)
 * …regardless of the other two flags.
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TransportPill } from '/@/renderer/features/jellyfin-remote-target/components/transport-pill';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const setPeerSync = (
    overrides: Partial<{
        enabled: boolean;
        jellyfinRemoteEnabled: boolean;
        onboarded: boolean;
        statusPill: boolean;
    }>,
) => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            enabled: overrides.enabled ?? prev.peerSync.enabled,
            jellyfinRemoteEnabled:
                overrides.jellyfinRemoteEnabled ?? prev.peerSync.jellyfinRemoteEnabled,
            onboarded: overrides.onboarded ?? prev.peerSync.onboarded,
            ui: {
                ...prev.peerSync.ui,
                statusPill: overrides.statusPill ?? prev.peerSync.ui.statusPill,
            },
        },
    });
};

const renderPill = () =>
    render(
        <MantineProvider>
            <TransportPill />
        </MantineProvider>,
    );

afterEach(() => {
    cleanup();
    // Reset to defaults that mirror the persisted-store defaults.
    setPeerSync({
        enabled: false,
        jellyfinRemoteEnabled: true,
        onboarded: false,
        statusPill: true,
    });
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('TransportPill visibility gating', () => {
    it('renders nothing when the user has not finished the wizard', () => {
        setPeerSync({ jellyfinRemoteEnabled: true, onboarded: false, statusPill: true });
        const { container } = renderPill();
        // MantineProvider injects a <style> tag at the top level; the pill
        // itself renders no Badge node when hidden.
        expect(container.querySelector('.mantine-Badge-root')).toBeNull();
    });

    it('renders nothing when the master kill-switch is off, even if onboarded', () => {
        setPeerSync({ jellyfinRemoteEnabled: false, onboarded: true, statusPill: true });
        const { container } = renderPill();
        // MantineProvider injects a <style> tag at the top level; the pill
        // itself renders no Badge node when hidden.
        expect(container.querySelector('.mantine-Badge-root')).toBeNull();
    });

    it('renders nothing when the per-element toggle is off, even if onboarded + master on', () => {
        setPeerSync({ jellyfinRemoteEnabled: true, onboarded: true, statusPill: false });
        const { container } = renderPill();
        // MantineProvider injects a <style> tag at the top level; the pill
        // itself renders no Badge node when hidden.
        expect(container.querySelector('.mantine-Badge-root')).toBeNull();
    });

    it('renders the "Local" pill when onboarded, master on, statusPill on, no target', () => {
        setPeerSync({ jellyfinRemoteEnabled: true, onboarded: true, statusPill: true });
        const { container } = renderPill();
        expect(container.querySelector('.mantine-Badge-root')).not.toBeNull();
        expect(container.textContent).toMatch(/local/i);
    });
});
