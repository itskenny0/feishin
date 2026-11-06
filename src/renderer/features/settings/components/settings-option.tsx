import React, { cloneElement, isValidElement, memo } from 'react';

import styles from './settings-option.module.css';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { MultiSelect } from '/@/shared/components/multi-select/multi-select';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';

// Form controls that take their accessible name from the row title.
const LABELLABLE: unknown[] = [
    Checkbox,
    MultiSelect,
    NumberInput,
    Select,
    Switch,
    Textarea,
    TextInput,
];

// Name the control after the row title unless it already has a name.
const withAccessibleName = (control: React.ReactNode, title: React.ReactNode) => {
    if (typeof title !== 'string' || !isValidElement(control)) return control;
    const props = control.props as Record<string, unknown>;
    if (LABELLABLE.includes(control.type) && !props['aria-label']) {
        return cloneElement(control as React.ReactElement<any>, { 'aria-label': title });
    }
    if (control.type === Slider && !props.thumbLabel && !props['aria-label']) {
        return cloneElement(control as React.ReactElement<any>, { thumbLabel: title });
    }
    return control;
};

interface SettingsOptionProps {
    control?: React.ReactNode;
    description?: React.ReactNode | string;
    indent?: boolean;
    isSubheader?: boolean;
    note?: string;
    showDescription?: boolean;
    title: React.ReactNode | string;
}

export const SettingsOptions = memo(
    ({
        control,
        description,
        indent,
        isSubheader,
        note,
        showDescription = true,
        title,
    }: SettingsOptionProps) => {
        const isMobileShell = useIsMobileShell();
        const namedControl = withAccessibleName(control, title);

        if (isSubheader) {
            // A "row" that's actually just a section header. Title-cased,
            // muted, with a hairline under it so the eye can break dense
            // option lists into chunks without us needing to spin up a
            // whole separate SettingsSection per group.
            return (
                <Group className={indent ? styles.subheaderIndented : styles.subheader}>
                    <Text fw={600} isNoSelect size="sm" tt="uppercase">
                        {title}
                    </Text>
                </Group>
            );
        }

        const label = (
            <>
                <Text isNoSelect size="md">
                    {title}
                </Text>
                {note && (
                    <Tooltip label={note} openDelay={400}>
                        <Icon icon="info" />
                    </Tooltip>
                )}
            </>
        );
        const descriptionNode =
            showDescription &&
            (React.isValidElement(description) ? (
                description
            ) : (
                <Text isMuted isNoSelect size="sm">
                    {description}
                </Text>
            ));

        // Mobile shell stacks label-above-control because the side-by-side
        // layout cramps both columns into uncomfortably narrow widths on a
        // 360px phone. Desktop keeps the label-left / control-right pair for
        // fast scanning. Mobile gap 'sm' (12px) keeps the muted description
        // from crowding the title and control.
        if (isMobileShell) {
            return (
                <Stack className={indent ? styles.rowIndented : styles.row} gap="sm">
                    <Group gap="xs" wrap="nowrap">
                        {label}
                    </Group>
                    {descriptionNode}
                    {control != null && control !== false && (
                        <Group className={styles.mobileControl} justify="flex-start" w="100%">
                            {namedControl}
                        </Group>
                    )}
                </Stack>
            );
        }

        return (
            <Group
                className={indent ? styles.rowIndented : styles.row}
                justify="space-between"
                wrap="nowrap"
            >
                <Stack className={styles.rowLabel} gap="xs">
                    <Group>{label}</Group>
                    {descriptionNode}
                </Stack>
                <Group justify="flex-end">{namedControl}</Group>
            </Group>
        );
    },
);
