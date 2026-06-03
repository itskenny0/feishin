import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';

interface CollapsibleSectionHeaderProps {
    collapsed: boolean;
    onToggle: () => void;
    title: string;
}

/**
 * Shared collapsible section header used on the album & album-artist detail
 * surfaces (genres, external links, etc). A keyboard-accessible row with a
 * chevron that flips based on the collapsed state.
 *
 * Promoted out of album-detail-content.tsx so the genres + social-links
 * displays can reuse the exact same affordance.
 */
export const CollapsibleSectionHeader = ({
    collapsed,
    onToggle,
    title,
}: CollapsibleSectionHeaderProps) => {
    return (
        <Group
            gap="xs"
            onClick={onToggle}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggle();
                }
            }}
            role="button"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            tabIndex={0}
            wrap="nowrap"
        >
            <Icon icon={collapsed ? 'arrowRightS' : 'arrowDownS'} size="md" />
            <Text fw={600} isNoSelect size="sm" tt="uppercase">
                {title}
            </Text>
        </Group>
    );
};
