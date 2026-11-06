import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '/@/renderer/api/query-keys';
import { RadioSubmenu } from '/@/renderer/features/context-menu/actions/radio-submenu';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useArtistRadioCount, useCurrentServerId } from '/@/renderer/store';
import { Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

interface PlayTrackRadioActionProps {
    disabled?: boolean;
    skipFirstSong?: boolean;
    song: Song;
}

export const PlayTrackRadioAction = ({
    disabled,
    skipFirstSong,
    song,
}: PlayTrackRadioActionProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const queryClient = useQueryClient();
    const radioCount = useArtistRadioCount();

    return (
        <RadioSubmenu
            disabled={disabled}
            label={t('player.trackRadio')}
            loadSongs={async (playType) => {
                if (!serverId || !song) return;
                const similarSongs = await queryClient.fetchQuery({
                    ...songsQueries.similar({
                        query: { count: radioCount, songId: song.id },
                        serverId,
                    }),
                    queryKey: queryKeys.player.fetch({
                        count: radioCount,
                        serverId,
                        similarSongs: song.id,
                    }),
                });
                if (!similarSongs?.length) return;
                // We need to skip the first song when adding to the queue as NEXT or LAST, otherwise you will have a duplicate song
                const shouldSkipFirstSong =
                    skipFirstSong && (playType === Play.NEXT || playType === Play.LAST);
                if (shouldSkipFirstSong) return similarSongs;
                // Pinned tiles pass a { id, name, imageId } stub; queue the full song.
                const seed =
                    song.duration == null
                        ? await queryClient.fetchQuery(
                              songsQueries.detail({ query: { id: song.id }, serverId }),
                          )
                        : song;
                return [seed ?? song, ...similarSongs];
            }}
        />
    );
};
