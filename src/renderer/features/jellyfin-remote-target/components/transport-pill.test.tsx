/**
 * Visibility-gate regression coverage for the player-bar transport pill.
 *
 * The pill is a Connect-related chrome element. Per the Sync & Connect
 * audit, it must stay hidden when any of:
 *   - the user hasn't finished the wizard (`onboarded=false`)
 *   - the master kill-switch is off (`jellyfinRemoteEnabled=false`)
 *   - the per-element toggle is off (`ui.statusPill=false`)
 * …regardless of the other two flags.
 *
 * Plus lane-resolution coverage (B5): the pill subscribes to transport flips
 * ONCE and re-resolves the current target's lane from the bridge when a
 * presence frame establishes/flips it — without re-subscribing on every
 * target change.
 *
 * Plus label-vocabulary coverage (F6): the shared `laneLabel` helper the pill
 * renders is the same mapping the Connect diagnostics flips table imports, so
 * both surfaces speak the same human vocabulary.
 */
import { MantineProvider } from '@mantine/core';
import { act, cleanup, render } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import {
    laneLabel,
    TransportPill,
} from '/@/renderer/features/jellyfin-remote-target/components/transport-pill';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import {
    recordPresence,
    __resetForTests as resetTransportSelector,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
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
    resetTransportSelector();
});

const setTarget = (deviceId: string) =>
    useRemoteTargetStore.getState().actions.setTarget({
        capabilities: [],
        deviceId,
        deviceName: 'Test Device',
        sessionId: 'sess-1',
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

describe('TransportPill lane resolution (B5)', () => {
    it('shows "Jellyfin" for a remote target with an empty bridge, then flips to "MQTT" when a fresh presence frame establishes the bridge — via a single persistent subscription', () => {
        setPeerSync({ jellyfinRemoteEnabled: true, onboarded: true, statusPill: true });
        setSyncEnabled(true);
        const jfDeviceId = 'jf-device-abc';
        setTarget(jfDeviceId);

        const { container } = renderPill();
        // Bridge empty -> falls back to the Jellyfin lane.
        expect(container.textContent).toMatch(/jellyfin/i);

        // A presence frame binds jfDeviceId -> peer AND marks the peer fresh,
        // so the selector fans out a flip the pill's persistent listener
        // catches and re-resolves to the MQTT lane.
        act(() => {
            recordPresence('peer-1', true, Date.now(), jfDeviceId);
        });
        expect(container.textContent).toMatch(/mqtt/i);
    });

    it('ignores flips for peers that are not the current target', () => {
        setPeerSync({ jellyfinRemoteEnabled: true, onboarded: true, statusPill: true });
        setSyncEnabled(true);
        setTarget('jf-device-mine');

        const { container } = renderPill();
        expect(container.textContent).toMatch(/jellyfin/i);

        // An unrelated peer announces a different deviceId — the pill must
        // not flip, since the bridge for our target is still empty.
        act(() => {
            recordPresence('peer-other', true, Date.now(), 'jf-device-someone-else');
        });
        expect(container.textContent).toMatch(/jellyfin/i);
        expect(container.textContent).not.toMatch(/mqtt/i);
    });
});

// F6: the diagnostics flips table imports this exact helper, so asserting the
// strings here pins the shared vocabulary both surfaces render.
describe('laneLabel shared helper (F6)', () => {
    const Probe = ({ lane }: { lane: 'jellyfin' | 'local' | 'mqtt' }) => {
        const { t } = useTranslation();
        return <span data-testid="label">{laneLabel(lane, t)}</span>;
    };

    const renderLabel = (lane: 'jellyfin' | 'local' | 'mqtt') =>
        render(
            <MantineProvider>
                <Probe lane={lane} />
            </MantineProvider>,
        );

    it('maps mqtt -> "MQTT"', () => {
        expect(renderLabel('mqtt').getByTestId('label').textContent).toBe('MQTT');
    });

    it('maps jellyfin -> "Jellyfin"', () => {
        expect(renderLabel('jellyfin').getByTestId('label').textContent).toBe('Jellyfin');
    });

    it('maps local -> "Local"', () => {
        expect(renderLabel('local').getByTestId('label').textContent).toBe('Local');
    });

    it('matches the lane label the pill renders for an MQTT target', () => {
        setPeerSync({ jellyfinRemoteEnabled: true, onboarded: true, statusPill: true });
        setSyncEnabled(true);
        const jfDeviceId = 'jf-device-xyz';
        setTarget(jfDeviceId);
        act(() => {
            recordPresence('peer-9', true, Date.now(), jfDeviceId);
        });
        const { container } = renderPill();
        const badge = container.querySelector('.mantine-Badge-root');
        expect(badge?.textContent).toBe('MQTT');
        // Same string the diagnostics flips table would render via laneLabel.
        const probe = renderLabel('mqtt');
        expect(badge?.textContent).toBe(probe.getByTestId('label').textContent);
    });
});
