import { ReactNode } from 'react';

import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

interface ActionRequiredContainerProps {
    children: ReactNode;
    title: string;
}

export const ActionRequiredContainer = ({ children, title }: ActionRequiredContainerProps) => (
    /*
     * `width: 100%` so the container actually shrinks to the viewport
     * width on phones. Without it the 700px max-width was treated as
     * the intrinsic content width and the form's inputs (full-width
     * URL, username, etc.) plus the server-type carousel below them
     * all extended past the right edge of the viewport on a 360–430px
     * phone — the user reported half of the placeholder text and the
     * OpenSubsonic chip got cut off.
     */
    <Stack style={{ cursor: 'default', maxWidth: '700px', width: '100%' }}>
        <Group>
            <Text size="xl" style={{ textTransform: 'uppercase' }}>
                {title}
            </Text>
        </Group>
        <Stack>{children}</Stack>
    </Stack>
);
