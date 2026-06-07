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
        t: (key: string, opts?: { context?: string; defaultValue?: string }) =>
            opts?.defaultValue ?? key,
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

import { ImageVariantsSettings } from '/@/renderer/features/settings/components/advanced/image-variants-settings';
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

const openPanel = () => {
    fireEvent.click(screen.getByText('Edit'));
};

describe('ImageVariantsSettings', () => {
    afterEach(() => {
        cleanup();
        clearThumbnails.mockClear();
        hydrate.mockClear();
    });

    beforeEach(() => {
        seedImageVariants('downscale');
    });

    it('renders the variant-source segmented control and all five buckets', () => {
        renderSettings();
        openPanel();

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
        openPanel();

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
        openPanel();

        // SegmentedControl renders radio inputs; the WebP/JPEG ones are
        // disabled when mode === download.
        const webp = screen.getByLabelText('WebP') as HTMLInputElement;
        expect(webp.disabled).toBe(true);
    });

    it('regenerate clears thumbnails and re-triggers the sweep', async () => {
        const server = { id: 'srv-1', userId: 'user-1' };
        renderSettings({ server });
        openPanel();

        fireEvent.click(screen.getByText('Regenerate variants now'));

        await vi.waitFor(() => {
            expect(clearThumbnails).toHaveBeenCalledTimes(1);
        });
        expect(hydrate).toHaveBeenCalledWith(server, 'full');
    });
});
