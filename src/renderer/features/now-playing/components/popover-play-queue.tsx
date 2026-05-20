import { t } from 'i18next';
import { useRef, useState } from 'react';

import styles from './popover-play-queue.module.css';

import { ItemListHandle } from '/@/renderer/components/item-list/types';
import { PlayQueue } from '/@/renderer/features/now-playing/components/play-queue';
import { PlayQueueListControls } from '/@/renderer/features/now-playing/components/play-queue-list-controls';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { useDisclosure } from '/@/shared/hooks/use-disclosure';
import { ItemListKey } from '/@/shared/types/types';

interface PopoverPlayQueueProps {
    onClose?: () => void;
    onToggle?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    opened?: boolean;
    /**
     * Total queue length. When > 0 a small numeric badge is rendered
     * in the top-right corner of the queue toggle button. Values
     * over 99 collapse to "99+" to keep the badge size constant.
     */
    queueLength?: number;
}

export const PopoverPlayQueue = ({
    onClose,
    onToggle,
    opened: controlledOpened,
    queueLength = 0,
}: PopoverPlayQueueProps = {}) => {
    const queueRef = useRef<ItemListHandle | null>(null);
    const [search, setSearch] = useState<string | undefined>(undefined);

    const [internalOpened, internalHandlers] = useDisclosure(false);

    const opened = controlledOpened !== undefined ? controlledOpened : internalOpened;
    const handleClose = onClose ? onClose : internalHandlers.close;
    const handleToggle = onToggle ? onToggle : internalHandlers.toggle;

    return (
        <Popover
            arrowSize={24}
            offset={12}
            onClose={handleClose}
            opened={opened}
            position="top"
            transitionProps={{
                transition: 'fade',
            }}
            withArrow
        >
            <Popover.Target>
                <div className={styles.queueButtonWrapper}>
                    <ActionIcon
                        icon="arrowUpToLine"
                        iconProps={{
                            size: 'lg',
                        }}
                        onClick={handleToggle}
                        size="sm"
                        tooltip={{
                            label: t('player.viewQueue'),
                            openDelay: 400,
                        }}
                        variant="subtle"
                    />
                    {queueLength > 0 && (
                        <span aria-hidden className={styles.queueBadge}>
                            {queueLength > 99 ? '99+' : queueLength}
                        </span>
                    )}
                </div>
            </Popover.Target>
            <Popover.Dropdown h="600px" mah="80dvh" opacity={0.95} p="xs" w="560px">
                <Stack gap={0} h="100%" w="100%">
                    <PlayQueueListControls
                        handleSearch={setSearch}
                        searchTerm={search}
                        tableRef={queueRef}
                        type={ItemListKey.SIDE_QUEUE}
                    />
                    <PlayQueue
                        listKey={ItemListKey.SIDE_QUEUE}
                        ref={queueRef}
                        searchTerm={search}
                    />
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
