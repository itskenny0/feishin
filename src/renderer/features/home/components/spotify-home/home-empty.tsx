import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './home-empty.module.css';

import { preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { Icon } from '/@/shared/components/icon/icon';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import { Text } from '/@/shared/components/text/text';

/**
 * Shown when the home page has nothing data-driven to render — a brand-new
 * server, an empty library, or a profile with no listening history yet. Keeps
 * Home from looking broken/dead by offering clear next steps into the library
 * rather than a blank scroll area.
 */
export const HomeEmpty = () => {
    const { t } = useTranslation();

    return (
        <div className={styles.empty}>
            <div aria-hidden="true" className={styles.iconWrap}>
                <Icon icon="sparkles" size="xl" />
            </div>
            <TextTitle className={styles.title} fw={800} order={2}>
                {t('page.home.empty_title', { defaultValue: 'Your library is ready' })}
            </TextTitle>
            <Text className={styles.subtitle} isMuted>
                {t('page.home.empty_subtitle', {
                    defaultValue:
                        'Start exploring — what you play and add will show up here as a personalised home.',
                })}
            </Text>
            <div className={styles.actions}>
                <Link
                    className={styles.action}
                    onMouseEnter={() => preloadRoute(AppRoute.LIBRARY_ALBUMS)}
                    to={AppRoute.LIBRARY_ALBUMS}
                >
                    <Icon icon="album" size="sm" />
                    {t('page.home.quickFilter_albums', { defaultValue: 'All albums' })}
                </Link>
                <Link
                    className={styles.action}
                    onMouseEnter={() => preloadRoute(AppRoute.LIBRARY_ALBUM_ARTISTS)}
                    to={AppRoute.LIBRARY_ALBUM_ARTISTS}
                >
                    <Icon icon="artist" size="sm" />
                    {t('page.home.quickFilter_artists', { defaultValue: 'All artists' })}
                </Link>
                <Link
                    className={styles.action}
                    onMouseEnter={() => preloadRoute(AppRoute.LIBRARY_SONGS)}
                    to={AppRoute.LIBRARY_SONGS}
                >
                    <Icon icon="track" size="sm" />
                    {t('page.home.quickFilter_tracks', { defaultValue: 'All tracks' })}
                </Link>
            </div>
        </div>
    );
};
