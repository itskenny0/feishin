import { useState } from 'react';

import { ActionSheet } from '/@/remote/components/action-sheet';
import {
    QueueReplaceConfirmRequest,
    useQueueReplaceConfirm,
    useRemoteLibraryStore,
} from '/@/remote/store/library';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';

// Mounted once (shell.tsx), not per-page — use-confirmed-send.ts is called
// from list rows scattered across every tab plus the long-press action
// sheets, so the pending confirmation itself lives in the shared library
// store rather than local state anywhere.
export const QueueReplaceConfirmSheet = () => {
    const pending = useQueueReplaceConfirm();
    const clear = useRemoteLibraryStore((state) => state.actions.clearQueueReplaceConfirm);
    // Tracked per request: the sheet can be dismissed mid-flight and a newer
    // confirmation shown before the older send settles.
    const [executing, setExecuting] = useState<null | QueueReplaceConfirmRequest>(null);
    const isExecuting = executing !== null && executing === pending;

    // Declining (Cancel, or dismissing the sheet any other way) still has to
    // settle the acked-send promise this confirmation is blocking on — see
    // QueueReplaceConfirmRequest's own comment — or the action sheet that
    // asked would spin forever.
    const handleDecline = () => {
        pending?.cancel();
        clear();
    };

    // The action sheet that asked for this (track/album/playlist-action-
    // sheet) closes itself the moment `pending` is set, so this is the only
    // place left to show that the send is in flight — closing instantly on
    // tap, like before, made the ack wait invisible.
    const handleConfirm = () => {
        if (!pending) return;
        const request = pending;
        setExecuting(request);
        request.execute().finally(() => {
            setExecuting((current) => (current === request ? null : current));
            // Clearing a newer request would close its sheet without ever
            // settling the send that is waiting on it.
            if (useRemoteLibraryStore.getState().queueReplaceConfirm === request) clear();
        });
    };

    return (
        <ActionSheet onClose={handleDecline} opened={!!pending}>
            <Stack gap="md" p="md">
                <Text fw={700}>Discard the current queue?</Text>
                <Text isMuted size="sm">
                    This will remove all items from the current queue.
                </Text>
                <Group gap="sm" grow>
                    <Button disabled={isExecuting} onClick={handleDecline} variant="default">
                        Cancel
                    </Button>
                    <Button loading={isExecuting} onClick={handleConfirm} variant="filled">
                        Confirm
                    </Button>
                </Group>
            </Stack>
        </ActionSheet>
    );
};
