import clsx from 'clsx';
import { memo, useCallback } from 'react';
import { Link, LinkProps, useLocation } from 'react-router';

import styles from './sidebar-item.module.css';

import { preloadRoute } from '/@/renderer/router/route-preloaders';
import { Button, ButtonProps } from '/@/shared/components/button/button';

export const computeSidebarItemActive = (to: LinkProps['to'], pathname: string): boolean => {
    const toPath = typeof to === 'string' ? to : to.pathname || '';
    // Use startsWith so sub-routes (e.g. /library/albums/123) still highlight
    // the parent nav item (e.g. /library/albums). Home ("/") matches everything
    // under startsWith, so it needs an exact-match special case.
    return toPath === '/' ? pathname === '/' : pathname.startsWith(toPath);
};

interface SidebarItemBaseProps extends Omit<ButtonProps, 'component' | 'ref'> {
    isActive: boolean;
    to: LinkProps['to'];
}

const SidebarItemBase = ({ children, className, isActive, to, ...props }: SidebarItemBaseProps) => {
    const toPath = typeof to === 'string' ? to : to.pathname || '';

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

// Memoized so that when the Sidebar re-renders on navigation (it owns the
// single lifted useLocation()), only the item whose precomputed isActive
// actually changed re-renders — not every nav item.
const MemoizedSidebarItemBase = memo(SidebarItemBase);

interface SidebarItemProps extends Omit<ButtonProps, 'component' | 'ref'> {
    // When provided, the parent has already computed the active state from a
    // single lifted useLocation(); this lets the memoized item avoid
    // subscribing to the router so only the changed item re-renders on
    // navigation. When omitted (e.g. mobile sidebar) we fall back to the
    // self-contained useLocation() subscription below.
    isActive?: boolean;
    to: LinkProps['to'];
}

const SidebarItemWithLocation = ({ to, ...props }: Omit<SidebarItemProps, 'isActive'>) => {
    const location = useLocation();
    const isActive = computeSidebarItemActive(to, location.pathname);
    return <MemoizedSidebarItemBase isActive={isActive} to={to} {...props} />;
};

export const SidebarItem = ({ isActive, to, ...props }: SidebarItemProps) => {
    if (isActive !== undefined) {
        return <MemoizedSidebarItemBase isActive={isActive} to={to} {...props} />;
    }
    return <SidebarItemWithLocation to={to} {...props} />;
};

export const MemoizedSidebarItem = memo(SidebarItem);
