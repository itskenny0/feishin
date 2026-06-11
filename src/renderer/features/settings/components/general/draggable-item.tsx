import { t } from 'i18next';
import { DragControls, Reorder, useDragControls } from 'motion/react';

import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { Group } from '/@/shared/components/group/group';
import { Text } from '/@/shared/components/text/text';

const DragHandle = ({ dragControls }: { dragControls: DragControls }) => {
    return (
        <ActionIcon
            aria-label={t('common.dragToReorder', { defaultValue: 'Drag to reorder' })}
            icon="dragVertical"
            iconProps={{
                size: 'md',
            }}
            onPointerDown={(event) => dragControls.start(event)}
            size="xs"
            // touchAction none is REQUIRED for Framer Motion drag on touch
            // devices — without it the browser claims the gesture for
            // scrolling and the drag never starts (reported on Android,
            // 2026-06-11).
            style={{ cursor: 'grab', touchAction: 'none' }}
            variant="transparent"
        />
    );
};

export interface DraggableItemProps {
    handleChangeDisabled: (id: string, e: boolean) => void;
    isFirst: boolean;
    isLast: boolean;
    item: SidebarItem;
    /** Touch-friendly fallback: move the row one slot without dragging. */
    onMove: (id: string, direction: -1 | 1) => void;
    value: string;
}

interface SidebarItem {
    disabled: boolean;
    id: string;
}

export const DraggableItem = ({
    handleChangeDisabled,
    isFirst,
    isLast,
    item,
    onMove,
    value,
}: DraggableItemProps) => {
    const dragControls = useDragControls();

    return (
        <Reorder.Item as="div" dragControls={dragControls} dragListener={false} value={item}>
            <Group py="md" style={{ boxShadow: '0 1px 3px rgba(0,0,0,.1)' }} wrap="nowrap">
                <Checkbox
                    checked={!item.disabled}
                    onChange={(e) => handleChangeDisabled(item.id, e.target.checked)}
                    size="xs"
                />
                <DragHandle dragControls={dragControls} />
                <Text style={{ flex: 1 }}>{value}</Text>
                <ActionIcon
                    aria-label={t('common.moveUp', { defaultValue: 'Move up' })}
                    disabled={isFirst}
                    icon="arrowUp"
                    iconProps={{ size: 'md' }}
                    onClick={() => onMove(item.id, -1)}
                    size="xs"
                    variant="transparent"
                />
                <ActionIcon
                    aria-label={t('common.moveDown', { defaultValue: 'Move down' })}
                    disabled={isLast}
                    icon="arrowDown"
                    iconProps={{ size: 'md' }}
                    onClick={() => onMove(item.id, 1)}
                    size="xs"
                    variant="transparent"
                />
            </Group>
        </Reorder.Item>
    );
};
