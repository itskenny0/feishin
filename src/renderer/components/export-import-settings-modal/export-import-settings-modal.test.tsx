// Importing a settings file validates the MIGRATED settings, so it must also
// apply the migrated settings. Applying the raw file merged old-version values
// (e.g. a null replayGainFallbackDB that a migration repairs) into the store.

import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ExportImportSettingsModal } from '/@/renderer/components/export-import-settings-modal/export-import-settings-modal';

const setSettings = vi.fn();

vi.mock('i18next', () => ({ t: (key: string) => key }));

vi.mock('/@/renderer/store', () => ({
    migrateSettings: (settings: Record<string, unknown>) => ({ ...settings, migrated: true }),
    useSettingsForExport: () => ({ version: 2 }),
    useSettingsStoreActions: () => ({ setSettings }),
    ValidationSettingsStateSchema: { safeParse: () => ({ success: true }) },
}));
vi.mock('/@/renderer/components/settings-diff-visualiser/settings-diff-visualiser', () => ({
    DiffVisualiser: () => null,
}));
vi.mock('/@/shared/components/drag-drop-zone/drag-drop-zone', () => ({
    DragDropZone: ({ onItemSelected }: { onItemSelected: (contents: string) => void }) => (
        <button onClick={() => onItemSelected(JSON.stringify({ general: {}, version: 1 }))}>
            pick
        </button>
    ),
}));

describe('ExportImportSettingsModal', () => {
    it('applies the migrated settings it validated, not the raw file', () => {
        render(
            <MantineProvider>
                <ExportImportSettingsModal />
            </MantineProvider>,
        );
        fireEvent.click(screen.getByText('pick'));
        fireEvent.click(screen.getByRole('button'));

        expect(setSettings).toHaveBeenCalledWith({ general: {}, migrated: true });
    });
});
