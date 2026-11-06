import { describe, expect, it, vi } from 'vitest';

import { appTheme, getAppTheme } from '/@/shared/themes/app-theme';
import { AppTheme } from '/@/shared/themes/app-theme-types';

vi.mock('is-electron', () => ({ default: () => true }));

const rawThemes = [
    {
        colors: { primary: 'rgb(1, 2, 3)' },
        extends: AppTheme.NORD,
        id: 'my-nord',
        label: 'My Nord',
        mode: 'dark',
    },
];

(window as unknown as { api: unknown }).api = {
    customThemes: {
        get: async () => rawThemes,
        onUpdate: () => () => {},
        openFolder: async () => {},
    },
};

describe('custom themes registry', () => {
    // docs/CUSTOM_THEMES.md: "Your theme is merged on top of the base". The
    // built-in base was never merged in, so an extending theme rendered on
    // top of the DEFAULT palette instead of the theme it extends.
    it('merges a custom theme on top of the built-in theme it extends', async () => {
        const { initCustomThemes } = await import('/@/renderer/store/custom-themes.store');
        await initCustomThemes();

        const theme = getAppTheme('my-nord');
        expect(theme.colors?.primary).toBe('rgb(1, 2, 3)');
        expect(theme.colors?.background).toBe(appTheme[AppTheme.NORD].colors?.background);
        expect(theme.app).toMatchObject(appTheme[AppTheme.NORD].app ?? {});
    });
});
