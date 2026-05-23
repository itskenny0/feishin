// Shared display formatters for cache-sync progress UI. SI decimal byte
// formatter (1 KB = 1000 bytes, not 1024) — matches what Jellyfin's web UI
// and most file managers use.
//
// Threshold rule: when the value's leading number is < 100, show one
// decimal place (e.g. "12.3 MB"). When >= 100, show no decimals
// ("856 KB", "2.4 GB"). Below 1 KB, show plain bytes ("412 B").

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export const formatBytes = (n: number | undefined): string => {
    if (n === undefined || !Number.isFinite(n) || n < 0) return '—';
    if (n < 1000) return `${Math.round(n)} B`;
    let v = n;
    let i = 0;
    while (v >= 1000 && i < UNITS.length - 1) {
        v /= 1000;
        i += 1;
    }
    const display = v < 100 ? v.toFixed(1) : Math.round(v).toString();
    return `${display} ${UNITS[i]}`;
};

// Format an integer count with thousands separators (locale-aware).
export const formatCount = (n: number | undefined): string => {
    if (n === undefined || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
};
