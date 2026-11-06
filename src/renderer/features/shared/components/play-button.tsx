import clsx from 'clsx';
import { t } from 'i18next';
import { forwardRef, memo } from 'react';

import styles from './play-button.module.css';

import { usePlayButtonClick } from '/@/renderer/features/shared/hooks/use-play-button-click';
import { ActionIcon, ActionIconProps } from '/@/shared/components/action-icon/action-icon';
import { AppIcon, Icon } from '/@/shared/components/icon/icon';
import { Spinner } from '/@/shared/components/spinner/spinner';

export interface DefaultPlayButtonProps extends ActionIconProps {
    size?: number | string;
}

export const DefaultPlayButton = forwardRef<HTMLButtonElement, DefaultPlayButtonProps>(
    ({ className, variant = 'filled', ...props }, ref) => {
        return (
            <ActionIcon
                aria-label={(props['aria-label'] as string | undefined) ?? t('player.play')}
                className={clsx(styles.textButton, className, {
                    [styles.unthemed]: variant !== 'filled',
                })}
                icon="mediaPlay"
                iconProps={{
                    size: 'xl',
                }}
                ref={ref}
                variant={variant}
                {...props}
            />
        );
    },
);

DefaultPlayButton.displayName = 'DefaultPlayButton';

interface PlayButtonProps {
    classNames?: string;
    fill?: boolean;
    icon?: keyof typeof AppIcon;
    isSecondary?: boolean;
    loading?: boolean;
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onLongPress?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const PlayButtonBase = forwardRef<HTMLButtonElement, PlayButtonProps>(
    (
        {
            classNames,
            fill,
            icon = 'mediaPlay',
            isSecondary,
            loading,
            onClick,
            onLongPress,
        }: PlayButtonProps,
        ref,
    ) => {
        const clickHandlers = usePlayButtonClick({
            loading,
            onClick,
            onLongPress,
        });

        return (
            <button
                aria-label={
                    icon === 'mediaPlayNext'
                        ? t('player.addNext')
                        : icon === 'mediaPlayLast'
                          ? t('player.addLast')
                          : t('player.play')
                }
                className={clsx(styles.playButton, classNames, {
                    [styles.fill]: fill,
                    [styles.secondary]: isSecondary,
                })}
                ref={ref}
                type="button"
                {...clickHandlers.handlers}
                {...clickHandlers.props}
            >
                {loading ? <Spinner color="black" /> : <Icon icon={icon} size="lg" />}
            </button>
        );
    },
);

export const PlayButton = memo(PlayButtonBase);

PlayButton.displayName = 'PlayButton';
