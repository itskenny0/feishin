import { DisplayTypeToggleButton } from '/@/renderer/features/shared/components/display-type-toggle-button';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useSettingsStore, useSettingsStoreActions } from '/@/renderer/store';
import { ItemListKey, ListDisplayType } from '/@/shared/types/types';

interface ListDisplayTypeToggleButtonProps {
    enableDetail?: boolean;
    listKey: ItemListKey;
}

export const ListDisplayTypeToggleButton = ({
    enableDetail = false,
    listKey,
}: ListDisplayTypeToggleButtonProps) => {
    const displayType = useSettingsStore(
        (state) => state.lists[listKey]?.display,
    ) as ListDisplayType;
    const { setList } = useSettingsStoreActions();
    // The Detail view's fixed 240px side column leaves no room on phones.
    const isMobileShell = useIsMobileShell();
    const allowDetail = enableDetail && !isMobileShell;

    const handleToggleDisplayType = () => {
        let newDisplayType: ListDisplayType;

        if (allowDetail) {
            if (displayType === ListDisplayType.DETAIL) {
                newDisplayType = ListDisplayType.TABLE;
            } else if (displayType === ListDisplayType.TABLE) {
                newDisplayType = ListDisplayType.GRID;
            } else if (displayType === ListDisplayType.GRID) {
                newDisplayType = ListDisplayType.DETAIL;
            } else {
                newDisplayType = ListDisplayType.GRID;
            }
        } else {
            if (displayType === ListDisplayType.GRID) {
                newDisplayType = ListDisplayType.TABLE;
            } else if (displayType === ListDisplayType.TABLE) {
                newDisplayType = ListDisplayType.GRID;
            } else {
                newDisplayType = ListDisplayType.GRID;
            }
        }

        setList(listKey, {
            display: newDisplayType,
        });

        return;
    };

    return <DisplayTypeToggleButton displayType={displayType} onToggle={handleToggleDisplayType} />;
};
