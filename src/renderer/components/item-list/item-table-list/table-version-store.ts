// Global list-data version pub/sub.
//
// react-window v2 does NOT reliably re-render already-mounted cells when the
// `cellProps` object changes, and prop-chains through suspense-retried hook
// instances proved fragile (a cell could stay subscribed to an instance
// whose version never advances). So the signal is GLOBAL and lives at module
// scope: every infinite-loader page write bumps it directly (no React
// involved), and every mounted table cell subscribes via
// useSyncExternalStore. A bump re-renders the visible cells (bounded by
// virtualization), which then re-read their rows through the live accessors.
// Verified against the playlists table where the first page froze as
// skeletons forever (device, 2026-06-10).

type Listener = () => void;

interface VersionChannel {
    listeners: Set<Listener>;
    version: number;
}

// Anchored on globalThis: the bundler can (and DOES) duplicate this module
// across chunks — the loader's copy bumped one `globalVersion` while the
// cells subscribed to another, and the signal silently vanished. A single
// globalThis-keyed channel is immune to chunk duplication.
const CHANNEL_KEY = '__feishinListDataVersion__';
const channel: VersionChannel = ((globalThis as Record<string, unknown>)[
    CHANNEL_KEY
] as VersionChannel) ?? { listeners: new Set<Listener>(), version: 0 };
(globalThis as Record<string, unknown>)[CHANNEL_KEY] = channel;

/** Bump after ANY list page write. Called from module scope — safe without React. */
export const bumpListDataVersion = (): void => {
    channel.version += 1;
    channel.listeners.forEach((cb) => cb());
};

export const subscribeListDataVersion = (cb: Listener): (() => void) => {
    channel.listeners.add(cb);
    return () => {
        channel.listeners.delete(cb);
    };
};

export const getListDataVersion = (): number => channel.version;
