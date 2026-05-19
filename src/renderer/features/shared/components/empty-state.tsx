import type { ReactNode } from 'react';

import { Center } from '/@/shared/components/center/center';
import { type AppIconSelection, Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

export interface EmptyStateProps {
    action?: ReactNode;
    description?: string;
    /**
     * Icon to render above the title. Defaults to an "empty song"
     * music note. Pass any name from AppIcon.
     */
    icon?: AppIconSelection;
    title: string;
}

/**
 * Friendly empty-state placeholder for list views that resolve to zero
 * rows. Centered icon + title + (optional) muted description + (optional)
 * call-to-action passed by the parent.
 *
 * Sized to fill the remaining viewport so the absence of content
 * doesn't read as a layout glitch — the area visibly says "nothing
 * here" instead of being a blank canvas.
 */
export const EmptyState = ({
    action,
    description,
    icon = 'emptySongImage',
    title,
}: EmptyStateProps) => {
    return (
        <Center style={{ flex: 1, minHeight: '50vh', padding: '2rem', width: '100%' }}>
            <Stack align="center" gap="md" style={{ maxWidth: '32rem', textAlign: 'center' }}>
                <Icon color="muted" icon={icon} size="4xl" />
                <Stack align="center" gap="xs">
                    <Text fw={600} size="lg">
                        {title}
                    </Text>
                    {description ? (
                        <Text isMuted size="sm">
                            {description}
                        </Text>
                    ) : null}
                </Stack>
                {action ? <div>{action}</div> : null}
            </Stack>
        </Center>
    );
};
