import React, { memo } from 'react';

import styles from './settings-option.module.css';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';

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
                    <Group className={styles.mobileControl} justify="flex-start" w="100%">
                        {control}
                    </Group>
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
                <Group justify="flex-end">{control}</Group>
            </Group>
        );
    },
);
