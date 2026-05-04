export const isAnalyticsDisabled = () => {
    // Analytics are opt-in: only enabled if the user explicitly turned them on
    // (which writes '0' to umami.disabled). Any other value, including absence,
    // means disabled.
    const isNotOptedIn = localStorage.getItem('umami.disabled') !== '0';
    const isDevMode = process.env.NODE_ENV === 'development';
    const isEnvOptOut =
        window && (window.ANALYTICS_DISABLED === true || window.ANALYTICS_DISABLED === 'true');

    return isNotOptedIn || isDevMode || isEnvOptOut;
};
