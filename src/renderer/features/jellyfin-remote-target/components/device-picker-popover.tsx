import { DevicePickerList } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-list';
import { Popover } from '/@/shared/components/popover/popover';

interface DevicePickerPopoverProps {
    children: React.ReactNode;
    onClose: () => void;
    opened: boolean;
    /** Override the dropdown anchor. Defaults to 'top-end' (desktop playerbar). */
    position?: 'top' | 'top-end' | 'top-start';
}

/**
 * Desktop presentation of the Jellyfin Connect picker: a Mantine Popover
 * anchored to the cast button. The device list itself lives in
 * DevicePickerList (shared with the mobile bottom sheet).
 */
export const DevicePickerPopover = ({
    children,
    onClose,
    opened,
    position = 'top-end',
}: DevicePickerPopoverProps) => {
    return (
        <Popover onClose={onClose} opened={opened} position={position} shadow="md" width={300}>
            <Popover.Target>{children}</Popover.Target>
            <Popover.Dropdown p="xs">
                <DevicePickerList onClose={onClose} />
            </Popover.Dropdown>
        </Popover>
    );
};
