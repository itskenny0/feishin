import isEqual from 'lodash/isEqual';
import { Reorder } from 'motion/react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DraggableItem } from '/@/renderer/features/settings/components/general/draggable-item';
import { SettingsOptions } from '/@/renderer/features/settings/components/settings-option';
import { useSettingSearchContext } from '/@/renderer/features/settings/context/search-context';
import { SortableItem } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';

export type DraggableItemsProps<K, T> = {
    description: string;
    itemLabels: Array<[K, string]>;
    items: T[];
    setItems: (items: T[]) => void;
    title: string;
};

const mergeItems = <K extends string, T extends SortableItem<K>>(
    items: T[],
    itemLabels: Array<[string, string]>,
): T[] => {
    const allItemIds = itemLabels.map(([key]) => key);

    const missingItemIds = allItemIds.filter((id) => !items.some((item) => item.id === id));

    const merged = [
        ...items,
        ...(missingItemIds.map((id) => ({
            disabled: true,
            id,
        })) as T[]),
    ];

    // Remove any duplicates
    const uniqueMerged = merged.filter(
        (item, index, self) => index === self.findIndex((t) => t.id === item.id),
    );

    // Remove any that don't match the itemLabels
    return uniqueMerged.filter((item) => itemLabels.some(([key]) => key === item.id));
};

export const DraggableItems = <K extends string, T extends SortableItem<K>>({
    description,
    itemLabels,
    items,
    setItems,
    title,
}: DraggableItemsProps<K, T>) => {
    const { t } = useTranslation();
    const keyword = useSettingSearchContext();
    const [open, setOpen] = useState(false);

    const translatedItemMap = useMemo(
        () =>
            Object.fromEntries(itemLabels.map(([key, value]) => [key, t(value)])) as Record<
                K,
                string
            >,
        [itemLabels, t],
    );

    const [localItems, setLocalItems] = useState(mergeItems(items, itemLabels));

    const handleChangeDisabled = useCallback((id: string, e: boolean) => {
        setLocalItems((items) =>
            items.map((item) => {
                if (item.id === id) {
                    return {
                        ...item,
                        disabled: !e,
                    };
                }

                return item;
            }),
        );
    }, []);

    // Touch-friendly reorder: Framer's drag needs touch-action:none + a
    // steady finger, which is fiddly on phones — the arrow buttons move a
    // row one slot per tap and work everywhere.
    const handleMove = useCallback((id: string, direction: -1 | 1) => {
        setLocalItems((current) => {
            const index = current.findIndex((item) => item.id === id);
            const target = index + direction;
            if (index === -1 || target < 0 || target >= current.length) return current;
            const next = [...current];
            const [moved] = next.splice(index, 1);
            next.splice(target, 0, moved);
            return next;
        });
    }, []);

    const titleText = t(title);
    const descriptionText = t(description, {
        context: 'description',
    });

    const shouldShow = useMemo(() => {
        return (
            keyword === '' ||
            title.toLocaleLowerCase().includes(keyword) ||
            description.toLocaleLowerCase().includes(keyword)
        );
    }, [description, keyword, title]);

    if (!shouldShow) {
        return null;
    }

    const isSaveButtonDisabled = isEqual(items, localItems);

    const handleSave = () => {
        setItems(localItems);
    };

    return (
        <>
            <SettingsOptions
                control={
                    <>
                        {open && (
                            <Button
                                disabled={isSaveButtonDisabled}
                                onClick={handleSave}
                                size="compact-md"
                                variant="filled"
                            >
                                {t('common.save')}
                            </Button>
                        )}
                        <Button
                            onClick={() => setOpen(!open)}
                            size="compact-md"
                            variant={open ? 'subtle' : 'filled'}
                        >
                            {t(open ? 'common.close' : 'common.edit')}
                        </Button>
                    </>
                }
                description={descriptionText}
                title={titleText}
            />
            {open && (
                <Reorder.Group
                    axis="y"
                    onReorder={setLocalItems}
                    style={{ userSelect: 'none' }}
                    values={localItems}
                >
                    {localItems.map((item, index) => (
                        <DraggableItem
                            handleChangeDisabled={handleChangeDisabled}
                            isFirst={index === 0}
                            isLast={index === localItems.length - 1}
                            item={item}
                            key={item.id}
                            onMove={handleMove}
                            value={translatedItemMap[item.id]}
                        />
                    ))}
                </Reorder.Group>
            )}
        </>
    );
};
