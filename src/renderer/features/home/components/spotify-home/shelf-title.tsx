import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './shelf-title.module.css';

import { preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { Icon } from '/@/shared/components/icon/icon';
import { TextTitle } from '/@/shared/components/text-title/text-title';

interface ShelfTitleProps {
    /** Destination for the "Show all" affordance. Omit to hide it. */
    showAllRoute?: AppRoute;
    title: string;
}

/**
 * Bold shelf heading with an optional "Show all" link, matching Spotify's
 * shelf header. Passed as the `title` ReactNode into the existing
 * `GridCarousel`-based carousels (which render it in their custom-title
 * slot alongside their own prev/next nav), and reused by the home-grown
 * artist/playlist shelves so every shelf header looks identical.
 *
 * The "Show all" link hover-preloads its route chunk so the navigation pop
 * is gone for users who hover before clicking.
 */
export const ShelfTitle = ({ showAllRoute, title }: ShelfTitleProps) => {
    const { t } = useTranslation();

    return (
        <div className={styles.shelfTitle}>
            <TextTitle className={styles.heading} fw={700} isNoSelect order={3} overflow="hidden">
                {title}
            </TextTitle>
            {showAllRoute && (
                <Link
                    className={styles.showAll}
                    onFocus={() => preloadRoute(showAllRoute)}
                    onMouseEnter={() => preloadRoute(showAllRoute)}
                    to={showAllRoute}
                >
                    {t('page.home.showAll', { defaultValue: 'Show all' })}
                    <Icon icon="arrowRightS" size="sm" />
                </Link>
            )}
        </div>
    );
};
