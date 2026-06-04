import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './home-hero.module.css';

import { useDominantColor } from '/@/renderer/features/player/hooks/use-dominant-color';
import { usePlayerSong } from '/@/renderer/store';
import { Text } from '/@/shared/components/text/text';

/**
 * Atmospheric hero zone that leads the redesigned home page.
 *
 * Composition mirrors Spotify's Home top zone: a soft, time-of-day-aware
 * greeting sitting on a quiet gradient wash. The wash is derived from the
 * currently-playing track's dominant cover colour (reusing the same
 * `useDominantColor` hook the player bar uses for its now-playing tint) so
 * the page feels connected to what the user is listening to. When nothing
 * is playing it falls back to a neutral theme-coloured gradient — never a
 * flat block.
 *
 * The greeting hour-boundaries are coarse enough that an afternoon→evening
 * shift mid-session is fine without a timer; we compute once per render.
 */
export const HomeHero = () => {
    const { t } = useTranslation();
    const currentSong = usePlayerSong();
    const { color } = useDominantColor(currentSong?.imageUrl);

    const hour = new Date().getHours();
    let greetingKey: 'afternoon' | 'evening' | 'morning' | 'night';
    if (hour < 5) greetingKey = 'night';
    else if (hour < 12) greetingKey = 'morning';
    else if (hour < 18) greetingKey = 'afternoon';
    else greetingKey = 'evening';

    const greeting = t(`page.home.greeting.${greetingKey}`);

    // The gradient is layered behind the greeting: an accent-derived radial
    // glow on top of the page background so the colour reads as "atmosphere"
    // rather than a coloured panel. `--home-hero-accent` falls back to the
    // theme primary when no dominant colour is available.
    const heroStyle = useMemo(
        () =>
            ({
                '--home-hero-accent': color ?? 'var(--theme-colors-primary)',
            }) as React.CSSProperties,
        [color],
    );

    return (
        <div className={styles.hero} style={heroStyle}>
            <div aria-hidden="true" className={styles.glow} />
            <Text className={styles.greeting} component="h1" isNoSelect overflow="hidden">
                {greeting}
            </Text>
        </div>
    );
};
