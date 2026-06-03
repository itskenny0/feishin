import clsx from 'clsx';

import styles from './offline-indicator.module.css';

import { Icon } from '/@/shared/components/icon/icon';

export interface OfflineIndicatorProps {
    className?: string;
    size?: '2xl' | '3xl' | '4xl' | 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    // When false, renders nothing — lets callers pass an availability boolean
    // inline without a wrapping conditional at every call site.
    visible: boolean;
    withSpace?: boolean;
}

/**
 * A small green cloud-download glyph shown to the LEFT of an entity name to
 * mark it as available offline. Mirrors the ExplicitIndicator placement
 * convention so it slots into the existing title columns / detail headers
 * without disturbing layout. Sourced from the offline-availability store
 * selectors (useIsSongOfflineAvailable / useIsEntityOfflineAvailable).
 */
export const OfflineIndicator = ({
    className,
    size = 'sm',
    visible,
    withSpace = true,
}: OfflineIndicatorProps) => {
    if (!visible) return null;

    return (
        <span
            aria-label="Available offline"
            className={clsx(styles.root, className, { [styles.withSpace]: withSpace })}
            title="Available offline"
        >
            <Icon color="success" icon="cache" size={size} />
        </span>
    );
};
