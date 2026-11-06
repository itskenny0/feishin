import { afterEach, describe, expect, it } from 'vitest';

import { getEnvSettingsOverrides } from '/@/renderer/store/env-settings-overrides';
import { AppTheme } from '/@/shared/themes/app-theme-types';

const env = window as unknown as Record<string, unknown>;

describe('getEnvSettingsOverrides', () => {
    afterEach(() => {
        delete env.FS_GENERAL_THEME;
    });

    // The accepted theme ids were a hand-maintained copy of the AppTheme enum
    // that had drifted (zenburn / spotify were silently rejected).
    it.each(Object.values(AppTheme))('accepts every built-in theme id (%s)', (theme) => {
        env.FS_GENERAL_THEME = theme;
        expect(getEnvSettingsOverrides().general?.theme).toBe(theme);
    });

    it('rejects an unknown theme id', () => {
        env.FS_GENERAL_THEME = 'notATheme';
        expect(getEnvSettingsOverrides().general?.theme).toBeUndefined();
    });
});
