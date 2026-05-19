import type { ContextModalProps } from '@mantine/modals';

import { closeAllModals } from '@mantine/modals';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FolderPlaylistMigrationTree } from './folder-playlist-migration-tree';

import { api } from '/@/renderer/api';
import { useCurrentServer } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type FolderPlaylistMigrationModalProps = {};

export type TreeNode = {
    childFolders: TreeNode[] | undefined; // undefined = not yet loaded
    childrenLoadingError?: string;
    id: string;
    isLoadingChildren: boolean;
    name: string;
    parentId: string | undefined;
};

function collectDescendantIds(nodes: TreeNode[], rootId: string): string[] {
    const root = findNode(nodes, rootId);
    if (!root || !root.childFolders) return [];
    const out: string[] = [];
    const walk = (n: TreeNode) => {
        out.push(n.id);
        if (n.childFolders) n.childFolders.forEach(walk);
    };
    root.childFolders.forEach(walk);
    return out;
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
    for (const n of nodes) {
        if (n.id === id) return n;
        if (n.childFolders) {
            const found = findNode(n.childFolders, id);
            if (found) return found;
        }
    }
    return undefined;
}

function mapNode(
    nodes: TreeNode[],
    targetId: string,
    mapper: (n: TreeNode) => TreeNode,
): TreeNode[] {
    return nodes.map((n) => {
        if (n.id === targetId) return mapper(n);
        if (!n.childFolders) return n;
        const next = mapNode(n.childFolders, targetId, mapper);
        return next === n.childFolders ? n : { ...n, childFolders: next };
    });
}

export const FolderPlaylistMigrationModal = (
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _props: ContextModalProps<FolderPlaylistMigrationModalProps>,
) => {
    const { t } = useTranslation();
    const currentServer = useCurrentServer();
    const serverId = currentServer?.id;

    const [playlistName, setPlaylistName] = useState(
        () => `Migrated ${new Date().toLocaleDateString()}`,
    );
    const [isPublic, setIsPublic] = useState(false);
    const [rootFolders, setRootFolders] = useState<TreeNode[]>([]);
    const [rootsLoading, setRootsLoading] = useState(true);
    const [rootsLoadingError, setRootsLoadingError] = useState<string | undefined>();
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

    const fetchRoots = useCallback(async () => {
        if (!serverId) return;
        setRootsLoading(true);
        setRootsLoadingError(undefined);
        try {
            const folder = await api.controller.getFolder({
                apiClientProps: { serverId },
                query: { id: '0', sortBy: SongListSort.NAME, sortOrder: SortOrder.ASC },
            });
            const nodes: TreeNode[] = (folder?.children?.folders ?? []).map((f) => ({
                childFolders: undefined,
                id: f.id,
                isLoadingChildren: false,
                name: f.name,
                parentId: undefined,
            }));
            setRootFolders(nodes);
        } catch (err) {
            setRootsLoadingError(
                err instanceof Error ? err.message : t('folderPlaylistMigration.rootsLoadError'),
            );
        } finally {
            setRootsLoading(false);
        }
    }, [serverId, t]);

    useEffect(() => {
        void fetchRoots();
    }, [fetchRoots]);

    const fetchChildren = useCallback(
        async (folderId: string) => {
            if (!serverId) return;
            setRootFolders((prev) =>
                mapNode(prev, folderId, (n) => ({
                    ...n,
                    childrenLoadingError: undefined,
                    isLoadingChildren: true,
                })),
            );
            try {
                const folder = await api.controller.getFolder({
                    apiClientProps: { serverId },
                    query: {
                        id: folderId,
                        sortBy: SongListSort.NAME,
                        sortOrder: SortOrder.ASC,
                    },
                });
                const children: TreeNode[] = (folder?.children?.folders ?? []).map((f) => ({
                    childFolders: undefined,
                    id: f.id,
                    isLoadingChildren: false,
                    name: f.name,
                    parentId: folderId,
                }));
                setRootFolders((prev) =>
                    mapNode(prev, folderId, (n) => ({
                        ...n,
                        childFolders: children,
                        isLoadingChildren: false,
                    })),
                );
            } catch (err) {
                setRootFolders((prev) =>
                    mapNode(prev, folderId, (n) => ({
                        ...n,
                        childrenLoadingError:
                            err instanceof Error
                                ? err.message
                                : t('folderPlaylistMigration.childrenLoadError'),
                        isLoadingChildren: false,
                    })),
                );
            }
        },
        [serverId, t],
    );

    const toggleExpanded = useCallback(
        (folderId: string) => {
            const isExpanding = !expandedIds.has(folderId);
            setExpandedIds((prev) => {
                const next = new Set(prev);
                if (next.has(folderId)) next.delete(folderId);
                else next.add(folderId);
                return next;
            });
            if (isExpanding) {
                const node = findNode(rootFolders, folderId);
                if (node && node.childFolders === undefined && !node.isLoadingChildren) {
                    void fetchChildren(folderId);
                }
            }
        },
        [expandedIds, fetchChildren, rootFolders],
    );

    const toggleSelected = useCallback(
        (folderId: string) => {
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(folderId)) {
                    next.delete(folderId);
                } else {
                    next.add(folderId);
                    const descendantIds = collectDescendantIds(rootFolders, folderId);
                    for (const id of descendantIds) next.delete(id);
                }
                return next;
            });
        },
        [rootFolders],
    );

    return (
        <Stack gap="md">
            <TextInput
                label={t('folderPlaylistMigration.playlistName')}
                onChange={(e) => setPlaylistName(e.currentTarget.value)}
                required
                value={playlistName}
            />
            <Switch
                checked={isPublic}
                description={t('folderPlaylistMigration.isPublicDescription')}
                label={t('folderPlaylistMigration.isPublic')}
                onChange={(e) => setIsPublic(e.currentTarget.checked)}
            />
            <Stack gap={4}>
                <Text weight={600}>{t('folderPlaylistMigration.folderTree')}</Text>
                <Text isMuted size="sm">
                    {t('folderPlaylistMigration.folderTree_description')}
                </Text>
            </Stack>
            <ScrollArea style={{ maxHeight: '50vh' }}>
                {rootsLoading ? (
                    <Text isMuted>{t('folderPlaylistMigration.loadingRoots')}</Text>
                ) : rootsLoadingError ? (
                    <Group gap="xs">
                        <Text isMuted>{rootsLoadingError}</Text>
                        <Button
                            onClick={() => void fetchRoots()}
                            size="compact-sm"
                            variant="default"
                        >
                            {t('folderPlaylistMigration.retry')}
                        </Button>
                    </Group>
                ) : (
                    <Stack gap={0}>
                        {rootFolders.map((node) => (
                            <FolderPlaylistMigrationTree
                                ancestorSelected={false}
                                depth={0}
                                expandedIds={expandedIds}
                                key={node.id}
                                node={node}
                                onToggleExpand={toggleExpanded}
                                onToggleSelect={toggleSelected}
                                selectedIds={selectedIds}
                                selectedViaParentTooltip={t(
                                    'folderPlaylistMigration.selectedViaParent',
                                )}
                            />
                        ))}
                    </Stack>
                )}
            </ScrollArea>
            <Group justify="space-between">
                <Text isMuted size="sm">
                    {t('folderPlaylistMigration.selectedFolders', { count: selectedIds.size })}
                </Text>
                <Group gap="xs">
                    <Button onClick={() => closeAllModals()} variant="default">
                        {t('folderPlaylistMigration.cancel')}
                    </Button>
                    <Button
                        disabled={selectedIds.size === 0 || playlistName.trim().length === 0}
                        variant="filled"
                    >
                        {t('folderPlaylistMigration.create')}
                    </Button>
                </Group>
            </Group>
        </Stack>
    );
};
