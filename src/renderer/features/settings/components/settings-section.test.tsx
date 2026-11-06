import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DraggableItems } from '/@/renderer/features/settings/components/general/draggable-items';
import { SettingsSection } from '/@/renderer/features/settings/components/settings-section';
import { useSettingSearchStore } from '/@/renderer/features/settings/store/search.store';

const setKeyword = (search: string) => useSettingSearchStore.setState({ search });

afterEach(() => {
    cleanup();
    setKeyword('');
});

describe('SettingsSection search filtering', () => {
    it('keeps `extra` content visible when no option title matches the keyword', () => {
        // The hotkey bindings table lives entirely in `extra` (options is
        // empty) and filters itself by the same keyword.
        setKeyword('volume');
        render(
            <MantineProvider>
                <SettingsSection
                    extra={<div>bindings table</div>}
                    options={[{ control: null, title: 'Unrelated option' }]}
                />
            </MantineProvider>,
        );

        expect(screen.getByText('bindings table')).toBeInTheDocument();
        expect(screen.queryByText('Unrelated option')).not.toBeInTheDocument();
    });

    it('still hides a section with no matching options and no extra', () => {
        setKeyword('volume');
        render(
            <MantineProvider>
                <SettingsSection options={[{ control: null, title: 'Unrelated' }]} title="Head" />
            </MantineProvider>,
        );

        expect(screen.queryByText('Head')).not.toBeInTheDocument();
    });
});

describe('DraggableItems search filtering', () => {
    const renderArtistConfig = () =>
        render(
            <MantineProvider>
                <DraggableItems
                    description="setting.artistConfiguration"
                    itemLabels={[['biography', 'table.column.biography']]}
                    items={[{ disabled: false, id: 'biography' }]}
                    setItems={() => {}}
                    title="setting.artistConfiguration"
                />
            </MantineProvider>,
        );

    it('matches the keyword against the translated title, not the i18n key', () => {
        // en: "Album artist page configuration"
        setKeyword('album artist page');
        renderArtistConfig();

        expect(screen.getByText('Album artist page configuration')).toBeInTheDocument();
    });

    it('does not match on i18n key fragments', () => {
        setKeyword('setting.');
        renderArtistConfig();

        expect(screen.queryByText('Album artist page configuration')).not.toBeInTheDocument();
    });
});
