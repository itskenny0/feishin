import type { Dispatch, SetStateAction } from 'react';

import * as RadixContextMenu from '@radix-ui/react-context-menu';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import {
    createContext,
    type ReactNode,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import styles from './context-menu.module.css';

import { animationVariants } from '/@/shared/components/animations/animation-variants';
import { AppIcon, Icon } from '/@/shared/components/icon/icon';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';

interface ContextMenuContext {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
}

export const ContextMenuContext = createContext<ContextMenuContext | null>(null);

interface ContentProps {
    bottomStickyContent?: ReactNode;
    children: ReactNode;
    onCloseAutoFocus?: (event: FocusEvent) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onFocusOutside?: (event: FocusEvent) => void;
    onPointerDownOutside?: (event: PointerEvent) => void;
    stickyContent?: ReactNode;
}

interface ContextMenuProps {
    children: ReactNode;
}

interface DividerProps {}

interface ItemProps {
    children: ReactNode;
    className?: string;
    disabled?: boolean;
    isSelected?: boolean;
    leftIcon?: keyof typeof AppIcon;
    onSelect?: (event: Event) => void;
    rightIcon?: keyof typeof AppIcon;
}

interface LabelProps extends React.ComponentPropsWithoutRef<'div'> {
    children: ReactNode;
}

interface SubmenuContext {
    cancelCloseTimeout: () => void;
    disabled?: boolean;
    isCloseDisabled?: boolean;
    open: boolean;
    setCloseTimeout: (timeout: NodeJS.Timeout) => void;
    setOpen: Dispatch<SetStateAction<boolean>>;
}

interface TargetProps {
    children: ReactNode;
}

export function ContextMenu(props: ContextMenuProps) {
    const { children } = props;

    const [open, setOpen] = useState(false);
    const context = useMemo(() => ({ open, setOpen }), [open]);

    return (
        <RadixContextMenu.Root onOpenChange={setOpen}>
            <ContextMenuContext.Provider value={context}>{children}</ContextMenuContext.Provider>
        </RadixContextMenu.Root>
    );
}

function Content(props: ContentProps) {
    const { bottomStickyContent, children, stickyContent } = props;
    const { open } = useContext(ContextMenuContext) as ContextMenuContext;

    return (
        <AnimatePresence>
            {open && (
                <RadixContextMenu.Portal forceMount>
                    <RadixContextMenu.Content
                        asChild
                        // Same collision-padding rule as SubContent — keeps
                        // the menu's edges inside the viewport on phones
                        // where the right-click point is close to the edge.
                        avoidCollisions
                        className={styles.content}
                        collisionPadding={12}
                    >
                        <motion.div
                            animate="show"
                            className={styles.content}
                            exit="hidden"
                            initial="hidden"
                        >
                            {stickyContent}
                            <ScrollArea className={styles.maxHeight}>{children}</ScrollArea>
                            {bottomStickyContent}
                        </motion.div>
                    </RadixContextMenu.Content>
                </RadixContextMenu.Portal>
            )}
        </AnimatePresence>
    );
}

function Divider(props: DividerProps) {
    return <RadixContextMenu.Separator {...props} className={styles.divider} />;
}

function Item(props: ItemProps) {
    const { children, className, disabled, isSelected, leftIcon, onSelect, rightIcon } = props;

    return (
        <RadixContextMenu.Item
            className={clsx(styles.item, className, {
                [styles.disabled]: disabled,
                [styles.selected]: isSelected,
                [styles['has-left-icon']]: !!leftIcon,
                [styles['has-right-icon']]: !!rightIcon,
            })}
            disabled={disabled}
            onSelect={onSelect}
        >
            {leftIcon && <Icon className={styles.leftIcon} icon={leftIcon} />}
            {children}
            {rightIcon && <Icon className={styles.rightIcon} icon={rightIcon} />}
        </RadixContextMenu.Item>
    );
}

function Label(props: LabelProps) {
    const { children, className, ...htmlProps } = props;

    return (
        <RadixContextMenu.Label className={clsx(styles.label, className)} {...htmlProps}>
            {children}
        </RadixContextMenu.Label>
    );
}

function Target(props: TargetProps) {
    const { children } = props;

    return (
        <RadixContextMenu.Trigger asChild className={styles.target}>
            {children}
        </RadixContextMenu.Trigger>
    );
}

const SubmenuContext = createContext<null | SubmenuContext>(null);

interface SubmenuContentProps {
    children: ReactNode;
    stickyContent?: ReactNode;
}

interface SubmenuProps {
    children: ReactNode;
    disabled?: boolean;
    isCloseDisabled?: boolean;
    open?: boolean;
}

interface SubmenuTargetProps {
    children: ReactNode;
}

function Submenu(props: SubmenuProps) {
    const { children, disabled, isCloseDisabled, open: isManuallyOpen } = props;
    const [open, setOpen] = useState(isManuallyOpen ?? false);
    const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        return () => {
            if (closeTimeoutRef.current) {
                clearTimeout(closeTimeoutRef.current);
            }
        };
    }, []);

    const cancelCloseTimeout = () => {
        if (closeTimeoutRef.current) {
            clearTimeout(closeTimeoutRef.current);
            closeTimeoutRef.current = null;
        }
    };

    const setCloseTimeout = (timeout: NodeJS.Timeout) => {
        closeTimeoutRef.current = timeout;
    };

    const context = useMemo(
        () => ({
            cancelCloseTimeout,
            disabled,
            isCloseDisabled,
            open,
            setCloseTimeout,
            setOpen,
        }),
        [disabled, isCloseDisabled, open],
    );

    // onOpenChange wires Radix's built-in dismiss paths back into our
    // controlled `open` state. Without it, tapping outside the submenu
    // (the parent menu, the backdrop, anywhere else) had no way to
    // close it — Radix's outside-pointerdown handler fires, but the
    // call to its internal close was a no-op because the primitive is
    // controlled. The only escape paths left were making a selection
    // or the system back button — the regression the user reported.
    return (
        <RadixContextMenu.Sub onOpenChange={setOpen} open={open}>
            <SubmenuContext.Provider value={context}>{children}</SubmenuContext.Provider>
        </RadixContextMenu.Sub>
    );
}

function SubmenuContent(props: SubmenuContentProps) {
    const { children, stickyContent } = props;
    const { cancelCloseTimeout, isCloseDisabled, setCloseTimeout, setOpen } = useContext(
        SubmenuContext,
    ) as SubmenuContext;

    const handleMouseEnter = () => {
        cancelCloseTimeout();
        setOpen(true);
    };

    const handleMouseLeave = () => {
        if (isCloseDisabled) {
            const timeout = setTimeout(() => {
                setOpen(false);
            }, 150);
            setCloseTimeout(timeout);
        } else {
            setOpen(false);
        }
    };

    /*
     * Render the SubContent unconditionally and let Radix's controlled
     * open state drive visibility. The previous `{open && ...}` gate
     * unmounted the SubContent the instant open flipped to false — but
     * that also removed Radix's outside-pointerdown listener from the
     * DOM, so taps outside the submenu had nothing to detect them
     * against. Net effect: once the submenu opened, only selecting an
     * item or pressing back closed it; tapping the parent menu or the
     * backdrop did nothing. Keeping the SubContent mounted (Radix
     * hides it via state, not via unmount) restores normal dismiss
     * behaviour via the onOpenChange wired up on the Sub above.
     */
    return (
        <RadixContextMenu.Portal>
            <RadixContextMenu.SubContent
                // Radix submenus always open to the right of their
                // trigger (Western LTR semantics). The off-screen
                // behaviour on phones is addressed in
                // context-menu.module.css by shrinking the menu width
                // on `pointer: coarse` so the parent + submenu fit
                // side-by-side when Radix's avoidCollisions shifts the
                // submenu inside the viewport.
                avoidCollisions
                className={styles.content}
                collisionPadding={12}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                sideOffset={4}
            >
                <motion.div
                    animate="show"
                    className={styles.innerContent}
                    initial="hidden"
                    variants={animationVariants.fadeIn}
                >
                    {stickyContent}
                    <ScrollArea className={styles.maxHeight}>{children}</ScrollArea>
                </motion.div>
            </RadixContextMenu.SubContent>
        </RadixContextMenu.Portal>
    );
}

function SubmenuTarget(props: SubmenuTargetProps) {
    const { children } = props;
    const { cancelCloseTimeout, disabled, open, setCloseTimeout, setOpen } = useContext(
        SubmenuContext,
    ) as SubmenuContext;
    const openTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        return () => {
            if (openTimeoutRef.current) {
                clearTimeout(openTimeoutRef.current);
            }
        };
    }, []);

    const handleMouseEnter = () => {
        if (disabled) return;

        cancelCloseTimeout();

        if (openTimeoutRef.current) {
            clearTimeout(openTimeoutRef.current);
        }

        openTimeoutRef.current = setTimeout(() => {
            setOpen(true);
            openTimeoutRef.current = null;
        }, 150);
    };

    const handleMouseLeave = () => {
        if (openTimeoutRef.current) {
            clearTimeout(openTimeoutRef.current);
            openTimeoutRef.current = null;
        }

        const timeout = setTimeout(() => {
            setOpen(false);
        }, 150);
        setCloseTimeout(timeout);
    };

    /*
     * Touch handling. Radix's SubTrigger relies on `mouseenter` to open
     * the submenu, which never fires reliably on touch — the click event
     * arrives first and, because the SubTrigger is a focusable
     * menu item, Radix interprets the tap as a `select` and closes the
     * whole context menu. The result on a phone was: tap the "Play"
     * row in the menu, the menu vanishes, and nothing happens.
     *
     * Override that here: when the user taps a SubTrigger, cancel the
     * default select behaviour (`event.preventDefault()`) and explicitly
     * toggle the submenu open. A second tap on the same trigger collapses
     * it. The opening also fires the mouse-enter timer, so we cancel it
     * here so we don't double-fire.
     */
    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (event.pointerType !== 'mouse') {
            event.preventDefault();
            event.stopPropagation();
            cancelCloseTimeout();
            if (openTimeoutRef.current) {
                clearTimeout(openTimeoutRef.current);
                openTimeoutRef.current = null;
            }
            setOpen(!open);
        }
    };

    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (disabled) return;
        // Suppress the synthesised click on touch — pointerdown already
        // toggled the submenu and Radix would otherwise route the click
        // through to the parent menu's onSelect.
        event.preventDefault();
        event.stopPropagation();
    };

    return (
        <RadixContextMenu.SubTrigger
            className={clsx({ [styles.disabled]: disabled })}
            disabled={disabled}
            onClick={handleClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerDown={handlePointerDown}
        >
            {children}
        </RadixContextMenu.SubTrigger>
    );
}

ContextMenu.Target = Target;
ContextMenu.Content = Content;
ContextMenu.Item = Item;
ContextMenu.Label = Label;
ContextMenu.Group = RadixContextMenu.Group;
ContextMenu.Submenu = Submenu;
ContextMenu.SubmenuTarget = SubmenuTarget;
ContextMenu.SubmenuContent = SubmenuContent;
ContextMenu.Divider = Divider;
ContextMenu.Arrow = RadixContextMenu.Arrow;
