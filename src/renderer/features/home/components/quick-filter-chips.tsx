import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './quick-filter-chips.module.css';

import { openShuffleAllModal } from '/@/renderer/features/player/components/shuffle-all-modal';
import { AppRoute } from '/@/renderer/router/routes';
import { Icon } from '/@/shared/components/icon/icon';

/**
 * Horizontal row of shortcut chips at the top of the home page. Each chip is
 * a one-click entry into a useful library slice — favorites, recently played,
 * shuffle-all, etc. Compact, doesn't move on hover beyond a 1px lift.
 *
 * Surfaced via the homeItems setting so users can hide it if they don't want
 * the extra row.
 */
export const QuickFilterChips = () => {
    const { t } = useTranslation();

    const handleShuffleAll = useCallback(() => {
        void openShuffleAllModal();
    }, []);

    return (
        <section className={styles.section}>
            <h2 className={styles.header}>{t('page.home.quickFilters_title')}</h2>
            <div className={styles.row}>
                <Link className={styles.chip} to={AppRoute.FAVORITES}>
                    <Icon icon="favorite" />
                    {t('page.home.quickFilter_favorites')}
                </Link>
                <Link className={styles.chip} to={AppRoute.LIBRARY_GENRES}>
                    <Icon icon="genre" />
                    {t('page.home.quickFilter_genres')}
                </Link>
                <Link className={styles.chip} to={AppRoute.LIBRARY_ALBUMS}>
                    <Icon icon="album" />
                    {t('page.home.quickFilter_albums')}
                </Link>
                <Link className={styles.chip} to={AppRoute.LIBRARY_ALBUM_ARTISTS}>
                    <Icon icon="artist" />
                    {t('page.home.quickFilter_artists')}
                </Link>
                <Link className={styles.chip} to={AppRoute.LIBRARY_SONGS}>
                    <Icon icon="track" />
                    {t('page.home.quickFilter_tracks')}
                </Link>
                <button className={styles.chip} onClick={handleShuffleAll} type="button">
                    <Icon icon="mediaShuffle" />
                    {t('page.home.quickFilter_shuffleAll')}
                </button>
            </div>
        </section>
    );
};
