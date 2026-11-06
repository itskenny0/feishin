import isElectron from 'is-electron';
import merge from 'lodash/merge';
import { create } from 'zustand';

import { logger } from '/@/renderer/utils/logger';
import { appTheme, setCustomThemeRegistry } from '/@/shared/themes/app-theme';
import { AppTheme, AppThemeConfiguration } from '/@/shared/themes/app-theme-types';

export interface CustomThemeMeta {
    error?: string;
    id: string;
    label: string;
    mode: 'dark' | 'light';
    warnings?: string[];
}

interface CustomThemesActions {
    openThemesFolder: () => Promise<void>;
    refresh: () => Promise<void>;
}

interface CustomThemesState {
    // Metadata for populating theme pickers (id/label/mode/error/warnings),
    // separate from the full AppThemeConfiguration objects which live in
    // the shared registry consumed by getAppTheme.
    themes: CustomThemeMeta[];
}

const customThemesApi = isElectron() ? window.api.customThemes : null;

type RawCustomTheme = CustomThemeMeta & {
    app?: Record<string, unknown>;
    colors?: Record<string, unknown>;
    extends?: string;
    mantineOverride?: Record<string, unknown>;
    stylesheetContents?: string[];
};

const toMeta = (raw: RawCustomTheme): CustomThemeMeta => ({
    error: raw.error,
    id: raw.id,
    label: raw.label,
    mode: raw.mode,
    warnings: raw.warnings,
});

const toRegistry = (rawThemes: RawCustomTheme[]): Record<string, AppThemeConfiguration> => {
    const registry: Record<string, AppThemeConfiguration> = {};

    for (const raw of rawThemes) {
        if (raw.error) continue;

        // If the theme extends a built-in theme id, merge it on top of that
        // base. Custom-on-custom extension is already flattened by the main
        // process (which then reports only the built-in id, if any, here).
        const base: Partial<AppThemeConfiguration> =
            (raw.extends && appTheme[raw.extends as AppTheme]) || {};
        const stylesheets = [...(base.stylesheets ?? []), ...(raw.stylesheetContents ?? [])];

        registry[raw.id] = {
            app: merge({}, base.app, raw.app),
            colors: merge({}, base.colors, raw.colors),
            mantineOverride: merge({}, base.mantineOverride, raw.mantineOverride),
            mode: raw.mode,
            stylesheets: stylesheets.length > 0 ? stylesheets : undefined,
        };
    }

    return registry;
};

export const useCustomThemesStore = create<CustomThemesActions & CustomThemesState>()((set) => ({
    openThemesFolder: async () => {
        try {
            await customThemesApi?.openFolder();
        } catch (error) {
            logger.warn('Failed to open custom themes folder', { error: String(error) });
        }
    },
    refresh: async () => {
        if (!customThemesApi) return;
        try {
            const rawThemes = (await customThemesApi.get()) as unknown as RawCustomTheme[];
            setCustomThemeRegistry(toRegistry(rawThemes));
            set({ themes: rawThemes.map(toMeta) });
            logger.debug('Refreshed custom themes', {
                errorCount: rawThemes.filter((t) => t.error).length,
                themeCount: rawThemes.length,
                themes: rawThemes.map((t) => t.label),
            });
        } catch (error) {
            logger.warn('Failed to refresh custom themes', { error: String(error) });
        }
    },
    themes: [],
}));

let unsubscribeFromUpdates: (() => void) | null = null;

// Call once (e.g. from app bootstrap) to load the initial theme list and
// keep it live-updated whenever files change in the themes folder.
export const initCustomThemes = async () => {
    if (!customThemesApi) return;

    await useCustomThemesStore.getState().refresh();

    if (!unsubscribeFromUpdates) {
        unsubscribeFromUpdates = customThemesApi.onUpdate((rawThemes) => {
            const typedThemes = rawThemes as unknown as RawCustomTheme[];
            setCustomThemeRegistry(toRegistry(typedThemes));
            useCustomThemesStore.setState({ themes: typedThemes.map(toMeta) });
        });
    }
};

export const useCustomThemes = () => useCustomThemesStore((state) => state.themes);
