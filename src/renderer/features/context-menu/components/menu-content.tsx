import { type ReactNode, useCallback, useLayoutEffect, useRef } from 'react';

import styles from './menu-content.module.css';

import { ContextMenu } from '/@/shared/components/context-menu/context-menu';

interface MenuContentProps {
    bottomStickyContent?: ReactNode;
    children: ReactNode;
    stickyContent?: ReactNode;
}

/*
 * Wrapper around <ContextMenu.Content> that collapses orphaned dividers.
 *
 * Why this exists: every menu lays its actions out as static JSX with
 * <ContextMenu.Divider /> separators interleaved between groups. Many of
 * those actions render `null` when they don't apply (rating not
 * supported by the server, no offline cache, web build with no file
 * explorer, multi-select disabling track radio, …). When a whole group
 * between two dividers collapses to nothing, the user is left with two
 * dividers stacked on top of each other — or a stray divider pinned to
 * the very top/bottom of the sheet. On a mobile bottom sheet those 1px
 * lines are visually prominent and read as broken layout.
 *
 * React's static child list can't detect this: a `<DownloadAction/>`
 * element that *renders* null is still a present element in the parent's
 * children — only its DOM output is empty. So we resolve it after layout
 * against the real DOM instead: scan the rendered children, and hide any
 * separator that is leading, trailing, or has no non-separator element
 * between it and the previous separator.
 *
 * The wrapper uses `display: contents` so it stays out of the box tree —
 * the items/dividers remain effective siblings of the shared component's
 * ScrollArea content, and every selector in context-menu.module.css
 * keeps matching. ContextMenu.Content's public API is untouched; callers
 * just swap the import.
 */
export const MenuContent = ({ bottomStickyContent, children, stickyContent }: MenuContentProps) => {
    const groupRef = useRef<HTMLDivElement>(null);

    const collapseOrphanDividers = useCallback(() => {
        const root = groupRef.current;
        if (!root) return;

        const nodes = Array.from(root.children) as HTMLElement[];
        let sawItemSinceDivider = false;

        for (const node of nodes) {
            const isSeparator = node.getAttribute('role') === 'separator';

            if (isSeparator) {
                // Orphan if nothing rendered since the previous separator
                // (or since the top of the menu).
                if (!sawItemSinceDivider) {
                    node.setAttribute('data-divider-orphan', 'true');
                } else {
                    node.removeAttribute('data-divider-orphan');
                }
                sawItemSinceDivider = false;
            } else {
                sawItemSinceDivider = true;
            }
        }

        // Walk back from the end and hide any trailing separators left
        // dangling after the last rendered item.
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
            const node = nodes[i];
            if (node.getAttribute('role') === 'separator') {
                node.setAttribute('data-divider-orphan', 'true');
            } else {
                break;
            }
        }
    }, []);

    // Re-run on every render/layout change so conditionally-rendered
    // actions (favourites support resolving, playlist query settling,
    // offline cache toggling) don't leave stale dividers behind.
    useLayoutEffect(() => {
        collapseOrphanDividers();

        const root = groupRef.current;
        if (!root || typeof MutationObserver === 'undefined') return;

        const observer = new MutationObserver(() => collapseOrphanDividers());
        observer.observe(root, { childList: true, subtree: false });

        return () => observer.disconnect();
    });

    return (
        <ContextMenu.Content
            bottomStickyContent={bottomStickyContent}
            stickyContent={stickyContent}
        >
            <div className={styles.group} ref={groupRef}>
                {children}
            </div>
        </ContextMenu.Content>
    );
};

MenuContent.displayName = 'MenuContent';
