import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// The settings store reads window.api.utils at module-init; stub before any
// import pulls the store in. See window-settings.test.tsx for the pattern.
vi.hoisted(() => {
    const g = globalThis as unknown as { window?: { api?: unknown } };
    g.window = g.window ?? {};
    g.window.api = {
        localSettings: { set: () => {} },
        utils: {
            isLinux: () => false,
            isMacOS: () => false,
            isWindows: () => true,
        },
    };
});

// Resolve i18n keys to their defaultValue so assertions can target the
// English labels without booting the full i18n runtime.
vi.mock('react-i18next', () => ({
    initReactI18next: { init: () => {}, type: '3rdParty' },
    useTranslation: () => ({
        t: (
            key: string,
            opts?: { context?: string; count?: number; defaultValue?: string; mode?: string },
        ) => {
            const template = opts?.defaultValue ?? key;
            // Minimal {{var}} interpolation so summary strings render like the
            // real i18n runtime (the row builds "{{mode}} · {{count}} ...").
            return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
                opts && name in opts
                    ? String((opts as Record<string, unknown>)[name])
                    : `{{${name}}}`,
            );
        },
    }),
}));

// Spy the regenerate side-effects (clear + sweep) without touching Dexie.
const clearThumbnails = vi.fn().mockResolvedValue(undefined);
const hydrate = vi.fn().mockResolvedValue(undefined);
vi.mock('/@/renderer/cache', () => ({
    clearThumbnails: (...args: unknown[]) => clearThumbnails(...args),
    hydrate: (...args: unknown[]) => hydrate(...args),
}));

vi.mock('/@/shared/components/toast/toast', () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

import {
    ImageVariantsRow,
    ImageVariantsSettings,
} from '/@/renderer/features/settings/components/advanced/image-variants-settings';
import { DEFAULT_IMAGE_VARIANTS, useSettingsStore } from '/@/renderer/store';

const seedImageVariants = (mode: 'download' | 'downscale' = 'downscale') => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        localCache: {
            ...prev.localCache,
            imageVariants: {
                ...DEFAULT_IMAGE_VARIANTS,
                mode,
                variants: { ...DEFAULT_IMAGE_VARIANTS.variants },
            },
        },
    });
};

const renderSettings = (props?: { server?: { id: string; userId: string } }) =>
    render(
        <MantineProvider>
            <ImageVariantsSettings server={props?.server as never} />
        </MantineProvider>,
    );

const renderRow = (onOpen = vi.fn()) =>
    render(
        <MantineProvider>
            <ImageVariantsRow onOpen={onOpen} />
        </MantineProvider>,
    );

describe('ImageVariantsSettings', () => {
    afterEach(() => {
        cleanup();
        clearThumbnails.mockClear();
        hydrate.mockClear();
    });

    beforeEach(() => {
        seedImageVariants('downscale');
    });

    it('renders the variant-source segmented control and all five buckets directly', () => {
        renderSettings();

        expect(screen.getByText('Download per size')).toBeInTheDocument();
        expect(screen.getByText('Downscale locally')).toBeInTheDocument();

        // Every surface bucket row (5 of them).
        expect(screen.getByText('List / table row')).toBeInTheDocument();
        expect(screen.getByText('Grid card')).toBeInTheDocument();
        expect(screen.getByText('Sidebar')).toBeInTheDocument();
        expect(screen.getByText('Page header')).toBeInTheDocument();
        expect(screen.getByText('Full-screen player')).toBeInTheDocument();
    });

    it('toggling a variant writes the updated nested object to the store', () => {
        renderSettings();

        // table starts enabled in the defaults — toggle it off.
        const tableSwitch = screen.getByLabelText('List / table row') as HTMLInputElement;
        expect(tableSwitch.checked).toBe(true);

        fireEvent.click(tableSwitch);

        const after = useSettingsStore.getState().localCache.imageVariants;
        expect(after?.variants.table.enabled).toBe(false);
        // Other buckets untouched.
        expect(after?.variants.itemCard.enabled).toBe(true);
        expect(after?.variants.fullScreen.px).toBe(DEFAULT_IMAGE_VARIANTS.variants.fullScreen.px);
    });

    it('disables the format/quality controls in download mode', () => {
        seedImageVariants('download');
        renderSettings();

        // SegmentedControl renders radio inputs; the WebP/JPEG ones are
        // disabled when mode === download.
        const webp = screen.getByLabelText('WebP') as HTMLInputElement;
        expect(webp.disabled).toBe(true);
    });

    it('regenerate clears thumbnails and re-triggers the sweep', async () => {
        const server = { id: 'srv-1', userId: 'user-1' };
        renderSettings({ server });

        fireEvent.click(screen.getByText('Regenerate variants now'));

        await vi.waitFor(() => {
            expect(clearThumbnails).toHaveBeenCalledTimes(1);
        });
        expect(hydrate).toHaveBeenCalledWith(server, 'full');
    });
});

describe('ImageVariantsRow (drill-down nav row)', () => {
    afterEach(() => cleanup());

    beforeEach(() => {
        seedImageVariants('downscale');
    });

    it('shows a summary of the current config and fires onOpen when clicked', () => {
        const onOpen = vi.fn();
        renderRow(onOpen);

        // Default config: three buckets enabled (itemCard, table, sidebar) —
        // header (redundant 300px) and fullScreen are off by default. Seeded to
        // downscale mode by beforeEach.
        const trigger = screen.getByText('Downscale locally · 3 sizes enabled');
        expect(trigger).toBeInTheDocument();

        fireEvent.click(trigger);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('reflects download mode and an increased enabled count in the summary', () => {
        // Enable all five buckets in download mode → "5 sizes enabled".
        const prev = useSettingsStore.getState();
        useSettingsStore.setState({
            ...prev,
            localCache: {
                ...prev.localCache,
                imageVariants: {
                    ...DEFAULT_IMAGE_VARIANTS,
                    mode: 'download',
                    variants: {
                        fullScreen: { enabled: true, px: 0 },
                        header: { enabled: true, px: 300 },
                        itemCard: { enabled: true, px: 300 },
                        sidebar: { enabled: true, px: 400 },
                        table: { enabled: true, px: 80 },
                    },
                },
            },
        });

        renderRow();
        expect(screen.getByText('Download per size · 5 sizes enabled')).toBeInTheDocument();
    });
});
