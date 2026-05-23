# Cache-warm-read verification scripts

These four Playwright drivers exercise the local-first Jellyfin cache against
a real (demo) Jellyfin server and produce structured reports + screenshots
under `/tmp/cache-verify/`.

Run prerequisites:

1.  `pnpm dev:web --host 127.0.0.1` (or `npx vite dev --config web.vite.config.ts --host 127.0.0.1`).
    The scripts target `http://127.0.0.1:5173`. Vite defaults to localhost
    (IPv6) so the explicit `--host` flag is required.
2.  Playwright is resolved as a normal devDependency (`pnpm install`
    pulls it in via `package.json`).

| Script | What it verifies |
| --- | --- |
| `measure.mjs` | The original benchmark (cold/warm/detail/favourite-toggle/search/rAF). Run after any cache-layer change to detect regressions. |
| `measure-restart.mjs` | Hydrate → warm session → **page reload** → re-measure every surface. Proves that snapshot persistence keeps surfaces warm across an app restart. Also injects 2 000 fake songs into a real playlist to exercise the large-playlist cache fast-path. |
| `measure-strict.mjs` | Strict variant of `measure-restart.mjs` that waits for a KNOWN cached album / playlist name to appear in the DOM (instead of any text), so a fast-rendered empty skeleton doesn't count as a hit. Use this when defending against false positives. |
| `verify-favorite-filter.mjs` | Injects `CachedFavorite` rows into Dexie and drives `/library/albums?favorite=true` to verify the favourite-filter cache path returns the right subset. Note: the album grid still bypasses the cache layer for the network fetch — the cache wrapper itself is exercised but the grid's loader is not. |

All four are self-contained; each invokes
`fetch('.../authenticatebyname')` directly to obtain a demo Jellyfin token,
seeds the auth store via `storageState`, then drives the app via Playwright.
