import clsx from 'clsx';
import { forwardRef, ReactNode } from 'react';
import { useLocation } from 'react-router';

import styles from './collapsed-sidebar-item.module.css';

import { Flex } from '/@/shared/components/flex/flex';
import { Text } from '/@/shared/components/text/text';
import { createPolymorphicComponent } from '/@/shared/utils/create-polymorphic-component';

interface CollapsedSidebarItemProps {
    activeIcon: ReactNode;
    disabled?: boolean;
    icon: ReactNode;
    label: string;
    route?: string;
}

const _CollapsedSidebarItem = forwardRef<HTMLDivElement, CollapsedSidebarItemProps>(
    ({ activeIcon, disabled, icon, label, route, ...props }: CollapsedSidebarItemProps, ref) => {
        const location = useLocation();
        // Highlight sub-routes too (e.g. /library/albums/123 lights up Albums).
        // Home '/' is an exact-match special case so it doesn't claim every path.
        const isMatch = route
            ? route === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(route)
            : false;

        return (
            <Flex
                align="center"
                className={clsx({
                    [styles.active]: isMatch,
                    [styles.container]: true,
                    [styles.disabled]: disabled,
                })}
                direction="column"
                ref={ref}
                tabIndex={0}
                {...props}
            >
                {isMatch ? <div className={styles.activeTabIndicator} /> : null}
                {isMatch ? activeIcon : icon}
                <Text
                    className={clsx({
                        [styles.active]: isMatch,
                        [styles.textWrapper]: true,
                    })}
                    fw="600"
                    isMuted={!isMatch}
                    size="xs"
                >
                    {label}
                </Text>
            </Flex>
        );
    },
);

export const CollapsedSidebarItem = createPolymorphicComponent<'button', CollapsedSidebarItemProps>(
    _CollapsedSidebarItem,
);
