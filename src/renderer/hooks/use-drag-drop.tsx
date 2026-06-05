import {
    attachClosestEdge,
    type Edge,
    extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
    BaseEventPayload,
    CleanupFn,
    ElementDragType,
} from '@atlaskit/pragmatic-drag-and-drop/dist/types/internal-types';
import {
    draggable,
    dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { disableNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DragPreview } from '/@/renderer/components/drag-preview/drag-preview';
import { LibraryItem } from '/@/shared/types/domain-types';
import { dndUtils, DragData, DragOperation, DragTarget } from '/@/shared/types/drag-and-drop';

interface UseDraggableProps {
    drag?: {
        getId: () => string[];
        getItem: () => unknown[];
        itemType?: LibraryItem;
        metadata?: Record<string, unknown>;
        onDragStart?: () => void;
        onDrop?: () => void;
        onGenerateDragPreview?: (data: BaseEventPayload<ElementDragType>) => void;
        operation: DragOperation[];
        target: DragTarget | string;
    };
    drop?: {
        canDrop: (args: { source: DragData }) => boolean;
        getData: () => DragData;
        onDrag: (args: { edge: Edge | null; source: DragData }) => void;
        onDragLeave: () => void;
        onDrop: (args: { edge: Edge | null; self: DragData; source: DragData }) => void;
    };
    isEnabled: boolean;
}

export const useDragDrop = <TElement extends HTMLElement>({
    drag,
    drop,
    isEnabled,
}: UseDraggableProps) => {
    const ref = useRef<null | TElement>(null);

    const [isDragging, setIsDragging] = useState(false);
    const [isDraggedOver, setIsDraggedOver] = useState<Edge | null>(null);

    // Read the latest drag/drop config (and presence) via refs so the registration
    // effect does not need them in its deps. pragmatic-dnd reads data lazily via
    // getInitialData/getData, so handlers seeing the current config is correct.
    const dragRef = useRef(drag);
    const dropRef = useRef(drop);
    dragRef.current = drag;
    dropRef.current = drop;

    // Whether a drag/drop config is present. Toggling presence must re-register, so
    // these participate in the effect deps; their internals do not.
    const hasDrag = !!drag;
    const hasDrop = !!drop;

    useEffect(() => {
        const element = ref.current;
        if (!element || !isEnabled) return;

        const functions: CleanupFn[] = [];

        if (hasDrag) {
            functions.push(
                draggable({
                    element,
                    getInitialData: () => {
                        const currentDrag = dragRef.current;
                        if (!currentDrag) return {};

                        const id = currentDrag.getId();
                        const item = currentDrag.getItem();

                        const data = dndUtils.generateDragData(
                            {
                                id,
                                item,
                                itemType: currentDrag.itemType,
                                operation: currentDrag.operation,
                                type: currentDrag.target,
                            },
                            currentDrag.metadata,
                        );
                        return data;
                    },
                    onDragStart: () => {
                        setIsDragging(true);
                        dragRef.current?.onDragStart?.();
                    },
                    onDrop: () => {
                        setIsDragging(false);
                        dragRef.current?.onDrop?.();
                    },
                    onGenerateDragPreview: (data) => {
                        const currentDrag = dragRef.current;
                        if (!currentDrag) return;

                        if (currentDrag.onGenerateDragPreview) {
                            return currentDrag.onGenerateDragPreview(data);
                        }

                        const dragData = dndUtils.generateDragData(
                            {
                                id: currentDrag.getId(),
                                item: currentDrag.getItem(),
                                itemType: currentDrag.itemType,
                                operation: currentDrag.operation,
                                type: currentDrag.target,
                            },
                            currentDrag.metadata,
                        ) as DragData;

                        disableNativeDragPreview({ nativeSetDragImage: data.nativeSetDragImage });
                        setCustomNativeDragPreview({
                            nativeSetDragImage: data.nativeSetDragImage,
                            render: ({ container }) => {
                                const root = createRoot(container);
                                root.render(<DragPreview data={dragData} />);
                                return () => root.unmount();
                            },
                        });
                    },
                }),
            );
        }

        if (hasDrop) {
            functions.push(
                dropTargetForElements({
                    canDrop: (args) => {
                        return (
                            dropRef.current?.canDrop?.({
                                source: args.source.data as unknown as DragData,
                            }) || false
                        );
                    },
                    element,
                    getData: (args) => {
                        const currentDrop = dropRef.current;
                        if (!currentDrop) return dndUtils.generateDragData({} as DragData);

                        const dropData = currentDrop.getData();

                        const data = dndUtils.generateDragData(dropData);

                        return attachClosestEdge(data, {
                            allowedEdges: ['top', 'bottom'],
                            element: args.element,
                            input: args.input,
                        });
                    },
                    onDrag: (args) => {
                        const closestEdgeOfTarget: Edge | null = extractClosestEdge(args.self.data);
                        dropRef.current?.onDrag?.({
                            edge: closestEdgeOfTarget,
                            source: args.source.data as unknown as DragData,
                        });
                        setIsDraggedOver(closestEdgeOfTarget);
                    },
                    onDragLeave: () => {
                        dropRef.current?.onDragLeave?.();
                        setIsDraggedOver(null);
                    },
                    onDrop: (args) => {
                        const closestEdgeOfTarget: Edge | null = extractClosestEdge(args.self.data);
                        dropRef.current?.onDrop?.({
                            edge: closestEdgeOfTarget,
                            self: args.self.data as unknown as DragData,
                            source: args.source.data as unknown as DragData,
                        });
                        setIsDraggedOver(null);
                    },
                }),
            );
        }

        return combine(...functions);
        // Register exactly once per element mount / enablement change. The drag/drop
        // config internals are read via refs inside the handlers, and isDragging /
        // isDraggedOver are OUTPUTS of those handlers, not inputs — so neither belongs
        // in the deps. Only enablement and the presence of a drag/drop config force
        // re-registration.
    }, [isEnabled, hasDrag, hasDrop]);

    return {
        isDraggedOver,
        isDragging,
        ref,
    };
};
