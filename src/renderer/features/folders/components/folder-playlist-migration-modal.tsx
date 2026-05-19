import type { ContextModalProps } from '@mantine/modals';

import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type FolderPlaylistMigrationModalProps = {};

export const FolderPlaylistMigrationModal = (
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _props: ContextModalProps<FolderPlaylistMigrationModalProps>,
) => {
    return (
        <Stack gap="md">
            <Text>Folder playlist migration — placeholder</Text>
        </Stack>
    );
};
