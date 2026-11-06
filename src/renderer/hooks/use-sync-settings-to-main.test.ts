import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { localSettings } = vi.hoisted(() => {
    const localSettings = { get: vi.fn(async () => undefined), set: vi.fn() };
    const g = globalThis as unknown as { window: { api?: unknown } };
    g.window.api = {
        localSettings,
        utils: { isLinux: () => false, isMacOS: () => false, isWindows: () => true },
    };
    return { localSettings };
});

vi.mock('is-electron', () => ({ default: () => true }));

import { useSyncSettingsToMain } from '/@/renderer/hooks/use-sync-settings-to-main';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const setDisableAutoUpdate = (disableAutoUpdate: boolean) =>
    useSettingsStore.getState().actions.setSettings({ window: { disableAutoUpdate } });

describe('useSyncSettingsToMain', () => {
    afterEach(() => {
        setDisableAutoUpdate(false);
        localSettings.set.mockClear();
    });

    it('mirrors disableAutoUpdate to the main store as soon as it changes', () => {
        const { unmount } = renderHook(() => useSyncSettingsToMain());

        // e.g. a settings import: the next launch's updater check reads the
        // main store before the delayed comparison would have run.
        setDisableAutoUpdate(true);
        expect(localSettings.set).toHaveBeenCalledWith('disable_auto_updates', true);

        unmount();
        localSettings.set.mockClear();
        setDisableAutoUpdate(false);
        expect(localSettings.set).not.toHaveBeenCalled();
    });
});
