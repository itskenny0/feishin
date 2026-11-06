import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '/@/renderer/api/query-keys';
import { RadioSubmenu } from '/@/renderer/features/context-menu/actions/radio-submenu';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useArtistRadioCount, useCurrentServerId } from '/@/renderer/store';
import { AlbumArtist, Artist } from '/@/shared/types/domain-types';

interface PlayArtistRadioActionProps {
    artist: AlbumArtist | Artist;
    disabled?: boolean;
}

export const PlayArtistRadioAction = ({ artist, disabled }: PlayArtistRadioActionProps) => {
    const artistRadioCount = useArtistRadioCount();
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const queryClient = useQueryClient();

    return (
        <RadioSubmenu
            disabled={disabled}
            label={t('player.artistRadio')}
            loadSongs={async () => {
                if (!serverId || !artist) return;
                return queryClient.fetchQuery({
                    ...songsQueries.artistRadio({
                        query: { artistId: artist.id, count: artistRadioCount },
                        serverId,
                    }),
                    queryKey: queryKeys.player.fetch({
                        artistId: artist.id,
                        count: artistRadioCount,
                        serverId,
                    }),
                });
            }}
        />
    );
};
