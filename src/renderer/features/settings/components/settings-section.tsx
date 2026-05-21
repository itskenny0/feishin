import { ReactNode, useState } from 'react';
import { RiArrowDownSLine, RiArrowRightSLine } from 'react-icons/ri';

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
    // Tablet+ keeps the existing roomy 2rem horizontal padding. On the
    // mobile shell that wasted half the viewport on a 360px phone — drop
    // to 0 so SettingsOptions get the full content width and the controls
    // (toggles, sliders, dropdowns) don't squish past their natural size.
    const isMobileShell = useIsMobileShell();

    /*
     * Mobile shell: collapse the section by default. Each tab in Settings
     * (General, Playback, Hotkeys, …) packs 7-10 sections; rendering them
     * all expanded on a phone means the user scrolls past ~40 individual
     * controls to find one. Collapsing each section into a tappable title
     * row lets the user scan the section TOC first, then drill in. When
     * the user is filtering with the global search, force everything
     * open so matched rows are visible inline without needing to expand.
     *
     * Desktop keeps everything inline — there's enough horizontal room
     * that a TOC pattern would be busywork on a wide screen.
     */
    const [open, setOpen] = useState(!isMobileShell || hasKeyword);
    const expanded = open || hasKeyword || !isMobileShell;

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

    // When filtering and the section has no matching rows, render nothing —
    // an empty collapsible header is just noise.
    if (hasKeyword && values.length === 0) {
        return null;
    }

    const titleNode = title ? (
        isMobileShell ? (
            <button
                aria-expanded={expanded}
                onClick={() => setOpen((v) => !v)}
                style={{
                    alignItems: 'center',
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: '0.5rem',
                    padding: '0.5rem 0',
                    textAlign: 'left',
                    width: '100%',
                }}
                type="button"
            >
                {expanded ? (
                    <RiArrowDownSLine size="1.2rem" />
                ) : (
                    <RiArrowRightSLine size="1.2rem" />
                )}
                <TextTitle fw={600} order={4}>
                    {title}
                </TextTitle>
            </button>
        ) : (
            <TextTitle fw={600} order={4}>
                {title}
            </TextTitle>
        )
    ) : null;

    return (
        <>
            {titleNode}
            {expanded && (
                <Stack gap="xl" px={isMobileShell ? 0 : 'xl'}>
                    {values.map((option) => (
                        <SettingsOptions key={`option-${option.title}`} {...option} />
                    ))}
                    {extra}
                </Stack>
            )}
        </>
    );
};
