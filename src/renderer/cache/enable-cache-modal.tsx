/**
 * Cache opt-in modal — RETIRED.
 *
 * The local cache is now MANDATORY for all installs (sync-only architecture):
 * the app is blocked behind the first-sync dashboard (see cache/sync-gate/)
 * until the library is cached, so there is nothing to opt into. The settings
 * default + the v67→68 migration force `localCache.enabled = true`.
 *
 * This component is kept as a no-op so the existing import in app.tsx and the
 * `EnableCacheModal` export stay valid; it renders nothing. It can be deleted
 * once all references are removed.
 */
export const EnableCacheModal = (): null => null;
