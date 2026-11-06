import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '/@/renderer/api/query-keys';
import { RadioSubmenu } from '/@/renderer/features/context-menu/actions/radio-submenu';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useArtistRadioCount, useCurrentServerId } from '/@/renderer/store';
import { Album } from '/@/shared/types/domain-types';

interface PlayAlbumRadioActionProps {
    album: Album;
    disabled?: boolean;
}

export const PlayAlbumRadioAction = ({ album, disabled }: PlayAlbumRadioActionProps) => {
    const albumRadioCount = useArtistRadioCount(); // Reuse the same setting for album radio
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const queryClient = useQueryClient();

    return (
        <RadioSubmenu
            disabled={disabled}
            label={t('player.albumRadio')}
            loadSongs={async () => {
                if (!serverId || !album) return;
                return queryClient.fetchQuery({
                    ...songsQueries.albumRadio({
                        query: { albumId: album.id, count: albumRadioCount },
                        serverId,
                    }),
                    queryKey: queryKeys.player.fetch({
                        albumId: album.id,
                        count: albumRadioCount,
                        serverId,
                    }),
                });
            }}
        />
    );
};
