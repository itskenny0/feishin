import { useTranslation } from 'react-i18next';

import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import { SimilarSongsList } from '/@/renderer/features/similar-songs/components/similar-songs-list';
import { usePlayerSong } from '/@/renderer/store';

export const FullScreenSimilarSongs = () => {
    const currentSong = usePlayerSong();

    const { t } = useTranslation();

    return currentSong?.id ? (
        <div style={{ height: '100%', width: '100%' }}>
            <SimilarSongsList fullScreen song={currentSong} />
        </div>
    ) : (
        <EmptyState title={t('player.noSongPlaying')} />
    );
};
