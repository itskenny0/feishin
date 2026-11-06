import { AppThemeConfiguration } from '/@/shared/themes/app-theme-types';

export const rosePineDawn: AppThemeConfiguration = {
    app: {
        'overlay-header':
            'linear-gradient(rgb(250 244 237 / 50%) 0%, rgb(250 244 237 / 80%)), var(--theme-background-noise)',
        'overlay-subheader':
            'linear-gradient(180deg, rgb(250 244 237 / 5%) 0%, var(--theme-colors-background)), var(--theme-background-noise)',
        'scrollbar-handle-active-background': 'rgba(206, 202, 205, 0.7)',
        'scrollbar-handle-background': 'rgba(244, 237, 232, 0.5)',
    },
    colors: {
        background: '#faf4ed', // base
        'background-alternate': '#faf4ed', // base
        foreground: '#575279', // text
        'foreground-muted': '#9893a5', // muted
        primary: '#d7827e', // rose
        'state-error': '#b4637a', // love
        'state-info': '#56949f', // foam
        'state-success': '#286983', // pine
        'state-warning': '#ea9d34', // gold
        surface: '#fffaf3', // surface
        'surface-foreground': '#797593', // subtle
    },
    mantineOverride: {
        primaryShade: {
            light: 4,
        },
    },
    mode: 'light',
};
