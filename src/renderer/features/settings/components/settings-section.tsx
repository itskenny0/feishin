import { ReactNode } from 'react';

import { SettingsOptions } from '/@/renderer/features/settings/components/settings-option';
import { useSettingSearchContext } from '/@/renderer/features/settings/context/search-context';
import { Stack } from '/@/shared/components/stack/stack';
import { TextTitle } from '/@/shared/components/text-title/text-title';

export type SettingOption = {
    control: ReactNode;
    description?: ReactNode | string;
    indent?: boolean;
    isHidden?: boolean;
    /**
     * When true, render the row as a sub-section header instead of a normal
     * label/control row. The header uses the `title` for its text and ignores
     * `control`, `description`, and `note` — it's purely a visual divider so
     * dense option lists (like the trackmap Advanced panel) can be grouped
     * into scannable chunks without spinning up a whole separate section.
     */
    isSubheader?: boolean;
    note?: string;
    title: string;
};

interface SettingsSectionProps {
    extra?: ReactNode;
    options: SettingOption[];
    title?: ReactNode;
}

export const SettingsSection = ({ extra, options, title }: SettingsSectionProps) => {
    const keyword = useSettingSearchContext();
    const hasKeyword = keyword !== '';

    // Subheaders are visual chunking only. When the user is filtering by a
    // keyword, hide them — a "Colors" header floating above an unrelated
    // matched row would read like a category label that didn't actually
    // group anything in the filtered view.
    const values = options.filter((o) => {
        if (o.isHidden) return false;
        if (hasKeyword && o.isSubheader) return false;
        if (hasKeyword && !o.title.toLocaleLowerCase().includes(keyword)) return false;
        return true;
    });

    return (
        <>
            {title && (
                <TextTitle fw={600} order={4}>
                    {title}
                </TextTitle>
            )}
            <Stack gap="xl" px="xl">
                {values.map((option) => (
                    <SettingsOptions key={`option-${option.title}`} {...option} />
                ))}
                {extra}
            </Stack>
        </>
    );
};
