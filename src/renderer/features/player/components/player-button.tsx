import clsx from 'clsx';
import { t } from 'i18next';
import { forwardRef, ReactNode } from 'react';

import styles from './player-button.module.css';

import { ActionIcon, ActionIconProps } from '/@/shared/components/action-icon/action-icon';
import { Tooltip, TooltipProps } from '/@/shared/components/tooltip/tooltip';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';

interface PlayerButtonProps extends Omit<ActionIconProps, 'icon' | 'variant'> {
    icon: ReactNode;
    isActive?: boolean;
    tooltip?: Omit<TooltipProps, 'children'>;
    variant: 'main' | 'secondary' | 'tertiary';
}

export const PlayerButton = forwardRef<HTMLButtonElement, PlayerButtonProps>(
    ({ icon, isActive, tooltip, variant, ...rest }: PlayerButtonProps, ref) => {
        // Derive aria-label from the tooltip label when no explicit one is
        // provided. The icon-only player buttons (stop/prev/next/shuffle-
        // all/queue-jump/etc.) previously had no accessible name at all —
        // screen readers announced 'button' with no context.
        const derivedAriaLabel =
            (rest['aria-label'] as string | undefined) ??
            (typeof tooltip?.label === 'string' ? tooltip.label : undefined);

        if (tooltip) {
            return (
                <Tooltip {...tooltip}>
                    <ActionIcon
                        aria-label={derivedAriaLabel}
                        className={clsx({
                            [styles.active]: isActive,
                        })}
                        ref={ref}
                        {...rest}
                        onClick={(e) => {
                            e.stopPropagation();
                            rest.onClick?.(e);
                        }}
                        variant="subtle"
                    >
                        {icon}
                    </ActionIcon>
                </Tooltip>
            );
        }

        return (
            <ActionIcon
                className={clsx(styles.playerButton, styles[variant], {
                    [styles.active]: isActive,
                })}
                ref={ref}
                {...rest}
                onClick={(e) => {
                    e.stopPropagation();
                    rest.onClick?.(e);
                }}
                variant="subtle"
            >
                {icon}
            </ActionIcon>
        );
    },
);

interface PlayButtonProps extends Omit<ActionIconProps, 'icon' | 'variant'> {
    isPaused?: boolean;
}

export const MainPlayButton = forwardRef<HTMLButtonElement, PlayButtonProps>(
    ({ isPaused, onClick, ...props }: PlayButtonProps, ref) => {
        const playerStateClass = isPaused
            ? PlaybackSelectors.playerStatePaused
            : PlaybackSelectors.playerStatePlaying;

        return (
            <ActionIcon
                className={clsx(styles.main, playerStateClass)}
                icon={isPaused ? 'mediaPlay' : 'mediaPause'}
                iconProps={{
                    size: 16,
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    onClick?.(e);
                }}
                ref={ref}
                // Pin the primary transport button to Spotify's 32×32 bar
                // play button (it uses 48 in the embed/fullscreen). Without
                // an explicit size the dimensions floated with the
                // ActionIcon `sm` default + icon `lg`, so it drifted across
                // themes. The coarse-pointer 44×44 floor in
                // playerbar.module.css still inflates the hit area on touch.
                size={32}
                tooltip={{
                    label: isPaused ? (t('player.play') as string) : (t('player.pause') as string),
                    openDelay: 400,
                }}
                {...props}
            />
        );
    },
);
