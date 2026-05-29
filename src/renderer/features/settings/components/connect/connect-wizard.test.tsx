/**
 * Wizard finish-flow regression coverage.
 *
 * The Sync & Connect onboarding wizard has one job: collect a tier choice
 * + broker URL/credentials, then atomically flip every persisted flag the
 * rest of the app gates on (`onboarded=true`, `enabled=true`,
 * `jellyfinRemoteEnabled=true`, plus the broker config the user picked).
 *
 * Before this suite a regression where the Finish click was silently
 * skipped — because two buttons matched "Finish" in the DOM (the Stepper
 * step label + the action button) and a query helper picked the wrong one
 * — went undetected because no test exercised the path. The harness here
 * fires the click directly on the action button so a future regression
 * fails loudly.
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectWizard } from '/@/renderer/features/settings/components/connect/connect-wizard';
import { useSettingsStore } from '/@/renderer/store/settings.store';

// nanoid is non-deterministic; pin it so we can assert on the seeded
// identity without flake.
vi.mock('nanoid', () => ({ nanoid: (length?: number) => (length ? 'k'.repeat(length) : 'pid') }));

const renderWizard = () =>
    render(
        <MantineProvider>
            <ConnectWizard />
        </MantineProvider>,
    );

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
            jellyfinRemoteEnabled: true,
            onboarded: false,
            peerId: '',
            roomKey: '',
            ui: { connectButton: true, pickerBadges: true, statusPill: true },
        },
    });
};

beforeEach(resetPeerSync);
afterEach(() => {
    cleanup();
    resetPeerSync();
});

const clickByText = (text: string) => {
    // Filter to actual <button> elements so the Mantine Stepper step labels
    // (also rendered as buttons because the wizard sets onStepClick) don't
    // accidentally consume the click intended for the action button at the
    // bottom of the step content.
    const buttons = screen
        .getAllByRole('button')
        .filter((b) => (b.textContent || '').trim() === text);
    expect(buttons.length).toBeGreaterThan(0);
    // The action button is always the LAST occurrence because the Stepper
    // labels render at the top of the DOM and the action button at the end.
    fireEvent.click(buttons[buttons.length - 1]);
};

describe('ConnectWizard', () => {
    it('persists the full opt-in state when the user finishes the own-broker flow', async () => {
        renderWizard();
        clickByText('Next'); // intro → tier
        // 'own' is the default; just advance.
        clickByText('Next'); // tier → configure
        const url = screen.getByPlaceholderText(/wss:\/\/broker\.example\.com/i);
        fireEvent.change(url, { target: { value: 'wss://my.broker.example.net:8083/mqtt' } });
        clickByText('Next'); // configure → finish
        clickByText('Finish');

        await waitFor(() => {
            const ps = useSettingsStore.getState().peerSync;
            expect(ps.onboarded).toBe(true);
            expect(ps.enabled).toBe(true);
            expect(ps.jellyfinRemoteEnabled).toBe(true);
            expect(ps.brokerUrl).toBe('wss://my.broker.example.net:8083/mqtt');
            // Identity seeded by the wizard's nanoid call.
            expect(ps.peerId.length).toBeGreaterThan(0);
            expect(ps.roomKey.length).toBeGreaterThan(0);
        });
    });

    it('keeps Next disabled on the configure step when the broker URL is empty', () => {
        renderWizard();
        clickByText('Next'); // intro → tier
        clickByText('Next'); // tier → configure (broker URL is empty)
        // On the configure step the action button is the last "Next".
        const buttons = screen
            .getAllByRole('button')
            .filter((b) => (b.textContent || '').trim() === 'Next');
        const actionNext = buttons[buttons.length - 1] as HTMLButtonElement;
        // Mantine renders disabled buttons with the native `disabled`
        // attribute, so the form-level guard works without jest-dom.
        expect(actionNext.disabled).toBe(true);
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
