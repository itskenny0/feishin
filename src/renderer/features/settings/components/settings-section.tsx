import { ReactNode } from 'react';

import { SettingsOptions } from '/@/renderer/features/settings/components/settings-option';
import { useSettingSearchContext } from '/@/renderer/features/settings/context/search-context';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
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
    const isMobileShell = useIsMobileShell();

    /*
     * Sections used to collapse-by-default on mobile to fit a long
     * scroll of many sections per category. Settings is now Android-
     * style drill-down (settings-layout.tsx) — each section lives on
     * its own subpage — so a collapsible inside the subpage would
     * just add an extra tap for no organisational benefit. Render the
     * title inline and let the options follow.
     */
    const values = options.filter((o) => {
        if (o.isHidden) return false;
        if (hasKeyword && o.isSubheader) return false;
        if (hasKeyword && !o.title.toLocaleLowerCase().includes(keyword)) return false;
        return true;
    });

    if (hasKeyword && values.length === 0) {
        return null;
    }

    const titleNode = title ? (
        <TextTitle fw={600} order={4}>
            {title}
        </TextTitle>
    ) : null;

    return (
        <>
            {titleNode}
            {/*
             * Mobile keeps a small horizontal gutter ('sm') instead of going
             * edge-flush (px=0) so labels and descriptions don't run into the
             * screen edge. Between-row spacing relaxes to 'lg' (was 'xl') so
             * section separation no longer dwarfs the within-row 'xs' gap —
             * a more balanced reading rhythm.
             */}
            <Stack gap="lg" px={isMobileShell ? 'sm' : 'xl'}>
                {values.map((option) => (
                    <SettingsOptions key={`option-${option.title}`} {...option} />
                ))}
                {extra}
            </Stack>
        </>
    );
};
