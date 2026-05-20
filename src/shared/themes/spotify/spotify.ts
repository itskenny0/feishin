import { AppThemeConfiguration } from '/@/shared/themes/app-theme-types';

/**
 * Spotify-flavoured theme preset.
 *
 * Carries the dark default surface palette but pins the accent to
 * Spotify's brand green (#1DB954). Useful as a one-click "make this look
 * like Spotify" option alongside the existing accent swatch.
 */
export const spotify: AppThemeConfiguration = {
    app: {},
    colors: {
        primary: 'rgb(29, 185, 84)',
    },
    mode: 'dark',
};
