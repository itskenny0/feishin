import React, { memo } from 'react';

import styles from './settings-option.module.css';

import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';

interface SettingsOptionProps {
    control: React.ReactNode;
    description?: React.ReactNode | string;
    indent?: boolean;
    isSubheader?: boolean;
    note?: string;
    title: React.ReactNode | string;
}

export const SettingsOptions = memo(
    ({ control, description, indent, isSubheader, note, title }: SettingsOptionProps) => {
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
        // Mobile shell stacks label-above-control because the side-by-side
        // layout cramps both columns into uncomfortably narrow widths on a
        // 360px phone. Desktop keeps the existing label-left / control-
        // right pair for fast scanning.
        if (isMobileShell) {
            return (
                <Stack className={indent ? styles.rowIndented : styles.row} gap="xs">
                    <Group gap="xs" wrap="nowrap">
                        <Text isNoSelect size="md">
                            {title}
                        </Text>
                        {note && (
                            <Tooltip label={note} openDelay={400}>
                                <Icon icon="info" />
                            </Tooltip>
                        )}
                    </Group>
                    {React.isValidElement(description) ? (
                        description
                    ) : (
                        <Text isMuted isNoSelect size="sm">
                            {description}
                        </Text>
                    )}
                    <Group justify="flex-start" w="100%">
                        {control}
                    </Group>
                </Stack>
            );
        }

        return (
            <>
                <Group
                    className={indent ? styles.rowIndented : styles.row}
                    justify="space-between"
                    wrap="nowrap"
                >
                    <Stack
                        gap="xs"
                        style={{
                            alignSelf: 'flex-start',
                            display: 'flex',
                            maxWidth: '50%',
                        }}
                    >
                        <Group>
                            <Text isNoSelect size="md">
                                {title}
                            </Text>
                            {note && (
                                <Tooltip label={note} openDelay={400}>
                                    <Icon icon="info" />
                                </Tooltip>
                            )}
                        </Group>
                        {React.isValidElement(description) ? (
                            description
                        ) : (
                            <Text isMuted isNoSelect size="sm">
                                {description}
                            </Text>
                        )}
                    </Stack>
                    <Group justify="flex-end">{control}</Group>
                </Group>
            </>
        );
    },
);
