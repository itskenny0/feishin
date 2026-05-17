import { t } from 'i18next';

import { ActionIcon, ActionIconProps } from '/@/shared/components/action-icon/action-icon';

interface MoreButtonProps extends ActionIconProps {}

export const MoreButton = ({ ...props }: MoreButtonProps) => {
    return (
        <ActionIcon
            // Default accessible name when caller hasn't provided one — this
            // is the universal '...' menu button, so 'Menu' is always
            // descriptive enough.
            aria-label={(props['aria-label'] as string | undefined) ?? t('common.menu')}
            icon="ellipsisHorizontal"
            iconProps={{
                size: 'lg',
                ...props.iconProps,
            }}
            variant="subtle"
            {...props}
        />
    );
};
