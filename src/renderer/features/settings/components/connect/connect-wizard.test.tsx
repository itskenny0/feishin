/**
 * Wizard finish-flow + connection-test-gate regression coverage.
 *
 * The Sync & Connect onboarding wizard collects a tier choice + broker
 * URL/credentials, makes the user prove the broker is reachable (the
 * connection-test gate), then atomically flips every persisted flag the rest
 * of the app gates on (`onboarded=true`, `enabled=true`,
 * `jellyfinRemoteEnabled=true`, plus the broker config the user picked).
 *
 * Two behaviours are pinned here:
 *   - Next on the Configure step is disabled until a connection test against
 *     the current broker config SUCCEEDS (testBrokerConnection mocked).
 *   - On Finish the persisted `roomKey` is the Jellyfin username — the broker
 *     auth password is deterministic so a user's own devices auto-pair.
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectWizard } from '/@/renderer/features/settings/components/connect/connect-wizard';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

// nanoid is non-deterministic; pin it so we can assert on the seeded
// identity without flake.
vi.mock('nanoid', () => ({ nanoid: (length?: number) => (length ? 'k'.repeat(length) : 'pid') }));

// The broker reachability probe. Default: succeed. Individual tests override
// the resolved value to exercise the gate.
const testBrokerConnection = vi.fn(async () => ({ ok: true }) as { error?: string; ok: boolean });
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    testBrokerConnection: (...args: unknown[]) =>
        (testBrokerConnection as unknown as (...a: unknown[]) => unknown)(...args),
}));

const renderWizard = () =>
    render(
        <MantineProvider>
            <ConnectWizard />
        </MantineProvider>,
    );

const seedServer = (username: string | undefined) => {
    useAuthStore.setState({
        ...useAuthStore.getState(),
        currentServer: username
            ? ({
                  id: 'srv-1',
                  type: 'jellyfin',
                  userId: 'user-1',
                  username,
              } as never)
            : null,
    });
};

const resetPeerSync = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            broker: { enabled: false, host: '0.0.0.0', port: 8083 },
            brokerPassword: '',
            brokerUrl: '',
            brokerUsername: '',
            enabled: false,
            homeAssistant: { deviceName: '', enabled: false },
            jellyfinRemoteEnabled: true,
            onboarded: false,
            peerId: '',
            roomKey: '',
            transport: 'auto',
            ui: {
                connectButton: true,
                hideNonMqttDevices: false,
                pickerBadges: true,
                statusPill: true,
            },
        },
    });
};

beforeEach(() => {
    testBrokerConnection.mockClear();
    testBrokerConnection.mockResolvedValue({ ok: true });
    seedServer('alice');
    resetPeerSync();
});
afterEach(() => {
    cleanup();
    resetPeerSync();
});

const buttonsByText = (text: string): HTMLButtonElement[] =>
    screen
        .getAllByRole('button')
        .filter((b) => (b.textContent || '').trim() === text) as HTMLButtonElement[];

const clickByText = (text: string) => {
    const buttons = buttonsByText(text);
    expect(buttons.length).toBeGreaterThan(0);
    // The action button is always the LAST occurrence because the Stepper
    // labels render at the top of the DOM and the action button at the end.
    fireEvent.click(buttons[buttons.length - 1]);
};

// Advance intro → tier → configure and fill in a broker URL.
const goToConfigureWithUrl = (url: string) => {
    clickByText('Next'); // intro → tier
    clickByText('Next'); // tier → configure ('own' default)
    const input = screen.getByPlaceholderText(/wss:\/\/broker\.example\.com/i);
    fireEvent.change(input, { target: { value: url } });
};

describe('ConnectWizard', () => {
    it('keeps Next disabled until the connection test passes, then persists roomKey = username', async () => {
        renderWizard();
        goToConfigureWithUrl('wss://my.broker.example.net:8083/mqtt');

        // Before any test, Next is gated.
        const nextBefore = buttonsByText('Next');
        expect(nextBefore[nextBefore.length - 1].disabled).toBe(true);

        // Run the (mocked-success) connection test.
        clickByText('Test connection');
        await waitFor(() => {
            expect(testBrokerConnection).toHaveBeenCalled();
            const nextAfter = buttonsByText('Next');
            expect(nextAfter[nextAfter.length - 1].disabled).toBe(false);
        });

        clickByText('Next'); // configure → finish
        clickByText('Finish');

        await waitFor(() => {
            const ps = useSettingsStore.getState().peerSync;
            expect(ps.onboarded).toBe(true);
            expect(ps.enabled).toBe(true);
            expect(ps.jellyfinRemoteEnabled).toBe(true);
            expect(ps.brokerUrl).toBe('wss://my.broker.example.net:8083/mqtt');
            expect(ps.peerId.length).toBeGreaterThan(0);
            // The room key is the Jellyfin username, not a random nanoid.
            expect(ps.roomKey).toBe('alice');
        });
    });

    it('keeps Next disabled when the connection test fails', async () => {
        testBrokerConnection.mockResolvedValue({ error: 'ECONNREFUSED', ok: false });
        renderWizard();
        goToConfigureWithUrl('wss://unreachable.example.net:8083');

        clickByText('Test connection');
        await waitFor(() => {
            expect(testBrokerConnection).toHaveBeenCalled();
            // The failure message surfaces.
            expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy();
        });
        const next = buttonsByText('Next');
        expect(next[next.length - 1].disabled).toBe(true);
    });

    it('resets the test gate when the broker URL changes after a successful test', async () => {
        renderWizard();
        goToConfigureWithUrl('wss://first.example.net:8083');
        clickByText('Test connection');
        await waitFor(() => {
            const next = buttonsByText('Next');
            expect(next[next.length - 1].disabled).toBe(false);
        });

        // Edit the URL — the prior success no longer applies; Next re-gates.
        const input = screen.getByPlaceholderText(/wss:\/\/broker\.example\.com/i);
        fireEvent.change(input, { target: { value: 'wss://second.example.net:8083' } });
        const next = buttonsByText('Next');
        expect(next[next.length - 1].disabled).toBe(true);
    });

    it('keeps Next disabled on the configure step when the broker URL is empty', () => {
        renderWizard();
        clickByText('Next'); // intro → tier
        clickByText('Next'); // tier → configure (broker URL is empty)
        const buttons = buttonsByText('Next');
        const actionNext = buttons[buttons.length - 1];
        expect(actionNext.disabled).toBe(true);
        // The Test connection button is also disabled with no URL.
        const testButtons = buttonsByText('Test connection');
        expect(testButtons[testButtons.length - 1].disabled).toBe(true);
    });

    it('flags a known public broker URL with a warning', () => {
        renderWizard();
        clickByText('Next'); // intro → tier
        // Pick "Public broker" tier
        fireEvent.click(screen.getByLabelText(/public broker/i));
        clickByText('Next'); // tier → configure
        // Select HiveMQ
        fireEvent.click(screen.getByLabelText(/hivemq/i));
        // The yellow alert surfaces the room-key visibility warning. Match
        // a specific phrase from the alert body to avoid colliding with the
        // tier-radio label "Public broker".
        expect(screen.getByText(/room key can see/i)).toBeTruthy();
    });

    it('shows an already-onboarded notice when re-run after the first opt-in', () => {
        useSettingsStore.setState({
            ...useSettingsStore.getState(),
            peerSync: {
                ...useSettingsStore.getState().peerSync,
                onboarded: true,
            },
        });
        renderWizard();
        expect(screen.getByText(/already set up/i)).toBeTruthy();
    });
});
