import type { TreeNode } from './folder-playlist-migration-modal';

import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';

export type FolderPlaylistMigrationTreeProps = {
    ancestorSelected: boolean;
    depth: number;
    expandedIds: Set<string>;
    node: TreeNode;
    onToggleExpand: (id: string) => void;
    onToggleSelect: (id: string) => void;
    selectedIds: Set<string>;
    selectedViaParentTooltip: string;
};

function anyDescendantSelected(node: TreeNode, selectedIds: Set<string>): boolean {
    if (!node.childFolders) return false;
    for (const child of node.childFolders) {
        if (selectedIds.has(child.id)) return true;
        if (anyDescendantSelected(child, selectedIds)) return true;
    }
    return false;
}

export const FolderPlaylistMigrationTree = (props: FolderPlaylistMigrationTreeProps) => {
    const {
        ancestorSelected,
        depth,
        expandedIds,
        node,
        onToggleExpand,
        onToggleSelect,
        selectedIds,
        selectedViaParentTooltip,
    } = props;

    const isDirectlySelected = selectedIds.has(node.id);
    const isEffectivelySelected = ancestorSelected || isDirectlySelected;
    const indeterminate = !isEffectivelySelected && anyDescendantSelected(node, selectedIds);

    const isExpanded = expandedIds.has(node.id);
    // Show expand chevron when we either know there are children (loaded array
    // non-empty) or haven't yet loaded children (undefined = unknown). If
    // children are loaded and empty, hide the chevron to avoid teasing.
    const showChevron = node.childFolders === undefined || node.childFolders.length > 0;

    return (
        <Stack gap={0}>
            <Group gap="xs" style={{ paddingLeft: `${depth * 20}px` }} wrap="nowrap">
                {showChevron ? (
                    <button
                        aria-label={isExpanded ? 'Collapse' : 'Expand'}
                        onClick={() => onToggleExpand(node.id)}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                        }}
                        type="button"
                    >
                        <Icon icon={isExpanded ? 'arrowDownS' : 'arrowRightS'} />
                    </button>
                ) : (
                    <span style={{ width: '1em' }} />
                )}
                <Tooltip
                    disabled={!ancestorSelected}
                    label={selectedViaParentTooltip}
                    openDelay={300}
                >
                    <Checkbox
                        aria-label={node.name}
                        checked={isEffectivelySelected}
                        disabled={ancestorSelected}
                        indeterminate={indeterminate}
                        onChange={() => onToggleSelect(node.id)}
                    />
                </Tooltip>
                <Text
                    size="sm"
                    style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {node.name}
                </Text>
            </Group>
            {isExpanded &&
                node.childFolders?.map((child) => (
                    <FolderPlaylistMigrationTree
                        ancestorSelected={isEffectivelySelected}
                        depth={depth + 1}
                        expandedIds={expandedIds}
                        key={child.id}
                        node={child}
                        onToggleExpand={onToggleExpand}
                        onToggleSelect={onToggleSelect}
                        selectedIds={selectedIds}
                        selectedViaParentTooltip={selectedViaParentTooltip}
                    />
                ))}
            {isExpanded && node.isLoadingChildren && (
                <Group gap="xs" style={{ paddingLeft: `${(depth + 1) * 20}px` }}>
                    <Text isMuted size="sm">
                        Loading…
                    </Text>
                </Group>
            )}
            {isExpanded && node.childrenLoadingError && (
                <Group gap="xs" style={{ paddingLeft: `${(depth + 1) * 20}px` }}>
                    <Text isMuted size="sm">
                        {node.childrenLoadingError}
                    </Text>
                </Group>
            )}
        </Stack>
    );
};
