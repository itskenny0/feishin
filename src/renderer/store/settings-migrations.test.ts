/**
 * Settings-store migration coverage. Each test seeds a persisted
 * `store_settings` blob at an old version, imports the store fresh, and
 * asserts on the rehydrated state — the same path a real upgrade takes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seed = (state: Record<string, unknown>, version: number) => {
    localStorage.setItem('store_settings', JSON.stringify({ state, version }));
};

const loadStore = async () => {
    vi.resetModules();
    const module = await import('/@/renderer/store/settings.store');
    return module.useSettingsStore;
};

describe('settings migrations', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    // The iPod-vs-phone MQTT discovery bug (device, 2026-06-10): the v48→49
    // wizard migration set onboarded=false for EVERY existing install,
    // including ones with peerSync.enabled=true and a configured broker.
    // Those installs keep their broker settings (UI looks configured) but
    // the subsystem mount gates on enabled && jellyfinRemoteEnabled &&
    // onboarded, so MQTT silently never boots again.
    it('grandfathers enabled peer-sync installs into onboarded', async () => {
        seed(
            {
                peerSync: {
                    brokerUrl: 'ws://192.168.0.10:1884',
                    enabled: true,
                    jellyfinRemoteEnabled: true,
                    onboarded: false,
                    peerId: 'abc123',
                },
            },
            61,
        );

        const store = await loadStore();
        expect(store.getState().peerSync.onboarded).toBe(true);
    });

    it('leaves never-enabled installs un-onboarded', async () => {
        seed(
            {
                peerSync: {
                    enabled: false,
                    onboarded: false,
                },
            },
            61,
        );

        const store = await loadStore();
        expect(store.getState().peerSync.onboarded).toBe(false);
    });

    it('survives a sparse blob without the peerSync slice', async () => {
        seed({}, 61);

        const store = await loadStore();
        // Migration must not throw (a throwing migrate wipes ALL settings);
        // defaults apply.
        expect(store.getState().peerSync.onboarded).toBe(false);
        expect(store.getState().peerSync.enabled).toBe(false);
    });
});
