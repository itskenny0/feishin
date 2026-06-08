import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import styles from './social-links-display.module.css';

import { CollapsibleSectionHeader } from '/@/renderer/features/shared/components/collapsible-section-header';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import {
    useDetailSectionCollapsed,
    useSetDetailSectionCollapsed,
} from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { AppIconSelection } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';

export interface SocialLinkDescriptor {
    href: string;
    icon: AppIconSelection;
    key: string;
    target?: string;
    tooltip: string;
}

interface SocialLinksDisplayProps {
    /**
     * Persisted collapse key for the mobile collapsible header, e.g.
     * `album.externalLinks` / `albumArtist.externalLinks`.
     */
    collapseKey: string;
    /** className passed to the brand-icon group (e.g. center-align rules). */
    groupClassName?: string;
    links: SocialLinkDescriptor[];
    /** Section title (defaults to "External links"). */
    title?: string;
}

const LinkGroup = ({ className, links }: { className?: string; links: SocialLinkDescriptor[] }) => (
    <Group className={className} gap="xs">
        {links.map((link) => (
            <ActionIcon
                component="a"
                href={link.href}
                icon={link.icon}
                iconProps={{ size: '2xl' }}
                key={link.key}
                radius="md"
                rel="noopener noreferrer"
                target={link.target ?? '_blank'}
                tooltip={{ label: link.tooltip, openDelay: 400 }}
                variant="subtle"
            />
        ))}
    </Group>
);

/**
 * External / social-links block.
 *
 * - Mobile (`useIsMobileShell`): a collapsible header (collapse state
 *   persisted via `useDetailSectionCollapsed`) over the brand-icon group.
 * - Desktop: renders inline but is scroll-aware — it rides the existing
 *   `data-scrolled` attribute set by `NativeScrollArea` on an ancestor
 *   container. Pure CSS fades the block out once the user scrolls past the
 *   top (show-at-top / hide-on-scroll), no extra JS.
 *
 * Caller gates rendering on `useSocialLinksDisplay() && externalLinks`.
 */
export const SocialLinksDisplay = ({
    collapseKey,
    groupClassName,
    links,
    title,
}: SocialLinksDisplayProps) => {
    const { t } = useTranslation();
    const isMobile = useIsMobileShell();
    // Default external links collapsed on the mobile shell to keep the detail
    // header compact; the user's explicit toggle still persists + wins.
    const collapsed = useDetailSectionCollapsed(collapseKey, isMobile);
    const setCollapsed = useSetDetailSectionCollapsed();

    if (links.length === 0) return null;

    const sectionTitle = title ?? t('common.externalLinks', { postProcess: 'sentenceCase' });

    if (isMobile) {
        return (
            <div className={styles.mobileContainer}>
                <CollapsibleSectionHeader
                    collapsed={collapsed}
                    onToggle={() => setCollapsed(collapseKey, !collapsed)}
                    title={sectionTitle}
                />
                {!collapsed && <LinkGroup className={groupClassName} links={links} />}
            </div>
        );
    }

    return (
        <div className={styles.desktopContainer}>
            <Text fw={600} isNoSelect size="sm" tt="uppercase">
                {sectionTitle}
            </Text>
            <div className={clsx(styles.scrollAwareSlot)}>
                <LinkGroup className={groupClassName} links={links} />
            </div>
        </div>
    );
};
