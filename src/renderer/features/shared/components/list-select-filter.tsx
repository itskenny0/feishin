import { useSelectFilter } from '/@/renderer/features/shared/hooks/use-select-filter';
import { Select } from '/@/shared/components/select/select';
import { ItemListKey } from '/@/shared/types/types';

export type SelectOption = string | { label: string; value: string };

interface ListSelectFilterProps {
    data?: Array<SelectOption>;
    filterKey: string;
    listKey: ItemListKey;
}

export const ListSelectFilter = ({ data, filterKey, listKey }: ListSelectFilterProps) => {
    const { setValue, value } = useSelectFilter(filterKey, '', listKey);

    // Re-selecting the current value clears the filter
    const handleSetValue = (newValue: string) => setValue(newValue === value ? '' : newValue);

    return (
        <Select
            data={data || []}
            onChange={(value) => handleSetValue(value ?? '')}
            value={value ?? ''}
        />
    );
};
