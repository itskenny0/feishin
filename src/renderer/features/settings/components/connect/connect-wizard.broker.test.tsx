/**
 * Desktop-only wizard behaviour around the embedded MQTT broker. Kept apart
 * from connect-wizard.test.tsx because it needs isElectron() === true and a
 * window.api stub in place before the wizard module captures `peerBrokerApi`.
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setEnabled } = vi.hoisted(() => {
    const setEnabled = vi.fn(async () => null as null | string);
    const g = globalThis as unknown as { window?: { api?: unknown } };
    g.window = g.window ?? {};
    g.window.api = {
        localSettings: { set: () => {} },
        peerBroker: { setEnabled, status: async () => ({ running: false }) },
        utils: { isLinux: () => true, isMacOS: () => false, isWindows: () => false },
    };
    return { setEnabled };
});

vi.mock('is-electron', () => ({ default: () => true }));
vi.mock('nanoid', () => ({ nanoid: () => 'pid' }));
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    testBrokerConnection: async () => ({ ok: true }),
}));

import { ConnectWizard } from '/@/renderer/features/settings/components/connect/connect-wizard';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seed = (brokerEnabled: boolean) => {
    useAuthStore.setState({
        ...useAuthStore.getState(),
        currentServer: { id: 'srv-1', type: 'jellyfin', userId: 'u1', username: 'alice' } as never,
    });
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            broker: { ...prev.peerSync.broker, enabled: brokerEnabled },
            brokerUrl: '',
            homeAssistant: { deviceName: '', enabled: false },
            onboarded: brokerEnabled,
        },
    });
};

const clickLast = (text: string) => {
    const buttons = screen
        .getAllByRole('button')
        .filter((b) => (b.textContent || '').trim() === text);
    fireEvent.click(buttons[buttons.length - 1]);
};

const renderWizard = () =>
    render(
        <MantineProvider>
            <ConnectWizard />
        </MantineProvider>,
    );

beforeEach(() => setEnabled.mockClear());
afterEach(() => {
    cleanup();
    seed(false);
});

describe('ConnectWizard embedded broker', () => {
    it('stops the running embedded broker when re-run with a URL-based tier', async () => {
        seed(true);
        renderWizard();

        clickLast('Next'); // intro -> tier (seeded as 'embedded')
        fireEvent.click(screen.getByLabelText(/your own mqtt broker/i));
        clickLast('Next'); // tier -> configure
        fireEvent.change(screen.getByPlaceholderText(/wss:\/\/broker\.example\.com/i), {
            target: { value: 'wss://own.example.net:8083/mqtt' },
        });
        clickLast('Test connection');
        await waitFor(() => {
            const next = screen
                .getAllByRole('button')
                .filter((b) => (b.textContent || '').trim() === 'Next');
            expect((next[next.length - 1] as HTMLButtonElement).disabled).toBe(false);
        });
        clickLast('Next'); // configure -> finish
        clickLast('Finish');

        await waitFor(() => expect(useSettingsStore.getState().peerSync.onboarded).toBe(true));
        expect(useSettingsStore.getState().peerSync.broker.enabled).toBe(false);
        expect(setEnabled).toHaveBeenCalledWith(null);
    });

    it('does not offer Home Assistant for the embedded tier (the bridge needs a broker URL)', async () => {
        seed(false);
        renderWizard();

        clickLast('Next'); // intro -> tier
        fireEvent.click(screen.getByLabelText(/zeroconf p2p/i));
        clickLast('Next'); // tier -> configure
        clickLast('Next'); // configure -> finish (embedded needs no test)

        expect(screen.queryByLabelText(/home assistant/i)).not.toBeInTheDocument();
        clickLast('Finish');

        await waitFor(() => expect(useSettingsStore.getState().peerSync.onboarded).toBe(true));
        expect(useSettingsStore.getState().peerSync.homeAssistant.enabled).toBe(false);
        expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ roomKey: 'alice' }));
    });
});
