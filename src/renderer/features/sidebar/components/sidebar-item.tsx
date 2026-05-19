import clsx from 'clsx';
import { memo, useCallback } from 'react';
import { Link, LinkProps, useLocation } from 'react-router';

import styles from './sidebar-item.module.css';

import { preloadRoute } from '/@/renderer/router/route-preloaders';
import { Button, ButtonProps } from '/@/shared/components/button/button';

interface SidebarItemProps extends Omit<ButtonProps, 'component' | 'ref'> {
    to: LinkProps['to'];
}

export const SidebarItem = ({ children, className, to, ...props }: SidebarItemProps) => {
    const location = useLocation();
    const toPath = typeof to === 'string' ? to : to.pathname || '';
    // Use startsWith so sub-routes (e.g. /library/albums/123) still highlight
    // the parent nav item (e.g. /library/albums). Home ("/") matches everything
    // under startsWith, so it needs an exact-match special case.
    const isActive =
        toPath === '/' ? location.pathname === '/' : location.pathname.startsWith(toPath);

    const handleLinkDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleHoverPreload = useCallback(() => {
        preloadRoute(toPath);
    }, [toPath]);

    return (
        <Button
            className={clsx(
                {
                    [styles.active]: isActive,
                    [styles.disabled]: props.disabled,
                    [styles.link]: true,
                    [styles.root]: true,
                },
                className,
            )}
            classNames={{
                inner: styles.inner,
                label: styles.label,
            }}
            component={Link}
            draggable={false}
            onDragStart={handleLinkDragStart}
            onFocus={handleHoverPreload}
            onMouseEnter={handleHoverPreload}
            to={to}
            variant="subtle"
            {...props}
        >
            {children}
        </Button>
    );
};

export const MemoizedSidebarItem = memo(SidebarItem);
