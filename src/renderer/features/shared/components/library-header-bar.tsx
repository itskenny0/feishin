import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { AnimatePresence } from 'motion/react';
import { CSSProperties, memo, ReactNode, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './library-header-bar.module.css';

import {
    OfflineDownloadEntity,
    useOfflineDownload,
} from '/@/renderer/features/context-menu/hooks/use-offline-download';
import { useIsPlayerFetching, usePlayer } from '/@/renderer/features/player/context/player-context';
import { DefaultPlayButton } from '/@/renderer/features/shared/components/play-button';
import { PlayButtonGroupPopover } from '/@/renderer/features/shared/components/play-button-group';
import { useCurrentServerId } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Badge, BadgeProps } from '/@/shared/components/badge/badge';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface LibraryHeaderBarProps {
    children: ReactNode;
    ignoreMaxWidth?: boolean;
}

const LibraryHeaderBarComponent = ({ children, ignoreMaxWidth }: LibraryHeaderBarProps) => {
    return (
        <div
            className={styles.headerContainer}
            style={ignoreMaxWidth ? ({ maxWidth: 'none' } as CSSProperties) : undefined}
        >
            {children}
        </div>
    );
};

interface HeaderPlayButtonProps {
    className?: string;
    ids?: string[];
    itemType: LibraryItem;
    listQuery?: Record<string, any>;
    songs?: Song[];
    variant?: 'default' | 'filled';
}

interface TitleProps {
    children: ReactNode;
    order?: number;
}

const HeaderPlayButton = ({
    className,
    ids,
    itemType,
    listQuery,
    songs,
    variant = 'filled',
    ...props
}: HeaderPlayButtonProps) => {
    const serverId = useCurrentServerId();
    const player = usePlayer();

    const handlePlay = useCallback(
        (playType: Play) => {
            if (listQuery) {
                player.addToQueueByListQuery(serverId, listQuery, itemType, playType);
            } else if (ids) {
                player.addToQueueByFetch(serverId, ids, itemType, playType);
            } else if (songs) {
                player.addToQueueByData(songs, playType);
            }

            closeAllModals();
        },
        [listQuery, ids, songs, player, serverId, itemType],
    );

    const isPlayerFetching = useIsPlayerFetching();

    const [isOpen, setIsOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    return (
        <div className={styles.playButtonContainer}>
            <DefaultPlayButton
                className={className}
                loading={isPlayerFetching}
                onClick={() => setIsOpen((prev) => !prev)}
                ref={buttonRef}
                variant={variant}
                {...props}
            />
            <AnimatePresence>
                {isOpen && (
                    <PlayButtonGroupPopover
                        loading={isPlayerFetching}
                        onClose={() => setIsOpen(false)}
                        onPlay={handlePlay}
                        position="bottom"
                        triggerRef={buttonRef}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

/**
 * Describes what the current page should download for offline playback when
 * the header's offline button is clicked.
 *
 *  - `entity`: a single entity (a detail page — album / artist / genre /
 *    playlist) → one offline target.
 *  - `list`: the collection currently in view (a library list page,
 *    respecting active filters/search) → one offline target per item.
 *    `getEntities` is resolved lazily on click so we don't enumerate the
 *    whole list on every render.
 */
export type OfflineSource =
    | {
          entity: OfflineDownloadEntity;
          type: 'entity';
      }
    | {
          getEntities: () => OfflineDownloadEntity[] | Promise<OfflineDownloadEntity[]>;
          // Best-effort count of items in view, used to decide whether to
          // confirm before kicking off a large download.
          itemCount?: number;
          type: 'list';
      };

interface OfflineButtonProps {
    source: OfflineSource;
}

// Confirm before downloading more than this many items from a list page.
const OFFLINE_LIST_CONFIRM_THRESHOLD = 25;

const OfflineHeaderButton = ({ source }: OfflineButtonProps) => {
    const { t } = useTranslation();
    const { available, download } = useOfflineDownload();

    const handleClick = useCallback(async () => {
        if (source.type === 'entity') {
            await download([source.entity]);
            return;
        }

        const count = source.itemCount;
        const start = async () => {
            const entities = await source.getEntities();
            if (entities.length === 0) return;
            await download(entities);
        };

        if (count !== undefined && count > OFFLINE_LIST_CONFIRM_THRESHOLD) {
            openConfirmModal({
                centered: true,
                children: t('page.contextMenu.offlineDownloadConfirmBody', {
                    count,
                    defaultValue:
                        'Download {{count}} items for offline playback? This may use significant storage.',
                }),
                labels: {
                    cancel: t('common.cancel', { defaultValue: 'Cancel' }),
                    confirm: t('page.contextMenu.downloadForOffline', {
                        defaultValue: 'Download for offline',
                    }),
                },
                onConfirm: () => void start(),
                title: t('page.contextMenu.offlineDownloadConfirmTitle', {
                    defaultValue: 'Download for offline',
                }),
            });
            return;
        }

        await start();
    }, [download, source, t]);

    if (!available) return null;

    return (
        <ActionIcon
            aria-label={t('page.contextMenu.downloadForOffline', {
                defaultValue: 'Download for offline',
            })}
            icon="cache"
            onClick={() => void handleClick()}
            tooltip={{
                label: t('page.contextMenu.downloadForOffline', {
                    defaultValue: 'Download for offline',
                }),
            }}
            variant="subtle"
        />
    );
};

const Title = ({ children, order = 1 }: TitleProps) => {
    return (
        <TextTitle fw={700} order={order as any} overflow="hidden">
            {children}
        </TextTitle>
    );
};

interface HeaderBadgeProps extends BadgeProps {
    isLoading?: boolean;
}

const HeaderBadge = ({ children, isLoading, ...props }: HeaderBadgeProps) => {
    return <Badge {...props}>{isLoading ? <Spinner /> : children}</Badge>;
};

export const LibraryHeaderBar = Object.assign(memo(LibraryHeaderBarComponent), {
    Badge: HeaderBadge,
    OfflineButton: OfflineHeaderButton,
    PlayButton: HeaderPlayButton,
    Title,
});
