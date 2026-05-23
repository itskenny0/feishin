#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/*
 * Variant of measure.mjs that adds Phase 7: cold-restart in the same
 * context. After the warm pass succeeds, we reload the page (NOT a new
 * context — same localStorage, same IndexedDB) and re-measure every
 * surface. This tests the user's "cache lost between restarts" complaint.
 *
 * Pre-fix, the in-memory snapshot map would be empty on the new page and
 * surfaces would show spinners. With the localStorage-backed persistence
 * in src/renderer/cache/snapshot.ts, the snapshot map is rehydrated
 * synchronously at module load and the first navigation finds primed data.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173';
const OUT = '/tmp/cache-verify/restart-v2';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[restart-v2]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SURFACES = [
    { name: 'Home', path: '#/' },
    { name: 'Albums', path: '#/library/albums' },
    { name: 'Artists', path: '#/library/album-artists' },
    { name: 'Songs', path: '#/library/songs' },
    { name: 'Playlists', path: '#/playlists' },
    { name: 'Favorites', path: '#/favorites' },
];

async function buildSeeded() {
    const deviceId = 'restart-v2-' + Math.random().toString(36).slice(2);
    const auth =
        'MediaBrowser Client="Feishin", Device="restart-v2", DeviceId="' +
        deviceId +
        '", Version="1.11.0"';
    const r = await fetch('https://demo.jellyfin.org/stable/users/authenticatebyname', {
        body: JSON.stringify({ Pw: '', Username: 'demo' }),
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': auth },
        method: 'POST',
    });
    if (!r.ok) throw new Error('auth failed: ' + r.status);
    const data = await r.json();
    const serverId = 'srv-' + Math.random().toString(36).slice(2);
    const serverItem = {
        credential: data.AccessToken,
        features: {},
        id: serverId,
        isAdmin: !!data.User.Policy?.IsAdministrator,
        name: 'Demo',
        type: 'jellyfin',
        url: 'https://demo.jellyfin.org/stable',
        userId: data.User.Id,
        username: data.User.Name,
    };
    const storeAuth = {
        state: { currentServer: serverItem, deviceId, serverList: { [serverId]: serverItem } },
        version: 2,
    };
    return {
        cookies: [],
        origins: [
            {
                localStorage: [{ name: 'store_authentication', value: JSON.stringify(storeAuth) }],
                origin: BASE,
            },
        ],
    };
}

async function clickEnableNow(page) {
    await sleep(2000);
    const enable = page.locator('button:has-text("Enable now")').first();
    if (await enable.isVisible().catch(() => false)) {
        await enable.click();
        log('opt-in clicked');
        await sleep(1500);
        return true;
    }
    return false;
}

async function clickSyncNow(page) {
    // Navigate to /library/albums and back to home to remount banner
    await sleep(2500);
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
        const btn = page.locator('button:has-text("Sync now")').first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            log('Sync now clicked');
            return true;
        }
        await sleep(500);
    }
    log('Sync now banner did not appear');
    return false;
}

const sweepWatcher = { completed: false, lastEvent: 0 };
async function bytesInfo(page) {
    return page.evaluate(async () => {
        try {
            const est = await navigator.storage?.estimate?.();
            return { quota: est?.quota ?? null, usage: est?.usage ?? null };
        } catch {
            return null;
        }
    });
}

async function clickFavouriteFilter(page) {
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    // Look for "Filters" toggle
    const filterBtns = [
        'button:has-text("Filters")',
        'button[aria-label*="filter" i]',
        'button:has-text("Filter")',
    ];
    let filterClicked = false;
    for (const sel of filterBtns) {
        const b = page.locator(sel).first();
        if (await b.isVisible().catch(() => false)) {
            await b.click();
            filterClicked = true;
            await sleep(300);
            break;
        }
    }
    // Look for a "Favourite" or "Favorite" toggle inside the opened popover
    let favClicked = false;
    const favSelectors = [
        'label:has-text("Favourite")',
        'label:has-text("Favorite")',
        '*[role="menuitem"]:has-text("Favourite")',
        '*[role="menuitem"]:has-text("Favorite")',
        'button:has-text("Favourite")',
        'button:has-text("Favorite")',
        'input[type="checkbox"][name*="favorite" i]',
    ];
    for (const sel of favSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
            await el.click();
            favClicked = true;
            await sleep(800);
            break;
        }
    }
    if (!favClicked) {
        log('fav: no fav toggle visible');
        return { favClicked: false, filterClicked };
    }
    // Measure spinner / content
    const start = Date.now();
    let spinnerAt = await page.evaluate(
        () => document.querySelectorAll('[class*="spinner" i], [data-loading="true"]').length,
    );
    let resolvedMs = null;
    try {
        await page.waitForFunction(
            () => {
                const sp = document.querySelectorAll(
                    '[class*="spinner" i], [data-loading="true"]',
                ).length;
                // Note: empty grid is also fine — the favs filter may match nothing
                const rows = document.querySelectorAll('.ag-row, [role="row"]').length;
                const main = document.querySelector('main') || document.body;
                const text = (main.textContent || '').trim();
                const hasNoMatch = text.match(/no (results|albums|matching)/i);
                return sp === 0 || rows > 0 || hasNoMatch;
            },
            { timeout: 5_000 },
        );
        resolvedMs = Date.now() - start;
    } catch {
        resolvedMs = -1;
    }
    return { favClicked, filterClicked, initialSpinner: spinnerAt, resolvedMs };
}

async function injectLargePlaylist(page, playlistId, count) {
    return page.evaluate(
        async ({ n, pid }) => {
            const dbs = await indexedDB.databases();
            const target = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
            if (!target) return { error: 'no db' };
            return new Promise((resolve) => {
                const open = indexedDB.open(target.name);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction(['playlistSongs'], 'readwrite');
                    const store = tx.objectStore('playlistSongs');
                    // Clear existing rows for this playlist first
                    const now = Date.now();
                    const index = store.index('PlaylistId');
                    const range = IDBKeyRange.only(pid);
                    const delReq = index.openCursor(range);
                    delReq.onsuccess = (ev) => {
                        const cur = ev.target.result;
                        if (cur) {
                            cur.delete();
                            cur.continue();
                        } else {
                            for (let i = 0; i < n; i++) {
                                store.put({
                                    __cachedAt: now,
                                    ListOrder: i,
                                    PlaylistId: pid,
                                    SongId: 'fake-song-' + i,
                                    SongPayload: {
                                        albumArtists: [],
                                        albumName: 'Fake Album',
                                        artistName: 'Fake Artist',
                                        artists: [],
                                        duration: 180,
                                        genres: [],
                                        id: 'fake-song-' + i,
                                        imageUrl: null,
                                        name: 'Fake Song ' + i,
                                        serverId: 'fake',
                                        serverType: 'jellyfin',
                                        streamUrl: '',
                                    },
                                });
                            }
                        }
                    };
                    tx.oncomplete = () => {
                        db.close();
                        resolve({ injected: n });
                    };
                    tx.onerror = () => {
                        db.close();
                        resolve({ error: 'tx failed' });
                    };
                };
                open.onerror = () => resolve({ error: 'open failed' });
            });
        },
        { n: count, pid: playlistId },
    );
}

async function main() {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const seeded = await buildSeeded();
    const context = await browser.newContext({
        storageState: seeded,
        viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();

    const consoleLog = [];
    page.on('console', (m) => consoleLog.push({ text: m.text(), type: m.type() }));
    page.on('pageerror', (e) => consoleLog.push({ text: e.message, type: 'pageerror' }));
    watchSweep(page);

    const results = { phases: {}, startedAt: new Date().toISOString() };
    try {
        // Phase 1: opt-in + hydration
        log('Phase 1: opt-in + hydrate');
        await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
        const optIn = await clickEnableNow(page);
        const syncNow = await clickSyncNow(page);
        const sweep = await waitSweep(page, 60_000);
        results.phases.hydrate = { optIn, sweep, syncNow };
        await page.screenshot({ path: join(OUT, '01-hydrated.png') });
        log('hydrate:', sweep);

        const bytesAfterHydrate = await bytesInfo(page);
        log('bytesAfterHydrate', bytesAfterHydrate);
        results.phases.bytesAfterHydrate = bytesAfterHydrate;

        // Phase 2: warm same-session — visit each surface
        log('Phase 2: warm same-session');
        const warmSession = [];
        for (const s of SURFACES) {
            const r = await measure(page, s);
            warmSession.push(r);
            log(
                '  warm-session',
                r.surface,
                'visible=' + r.visibleMs + 'ms api=' + r.apiRequestCount,
            );
        }
        results.phases.warmSession = warmSession;
        await page.screenshot({ path: join(OUT, '02-warm-session.png') });

        const snapAfterSession = await snapInfo(page);
        const bytesAfterSession = await bytesInfo(page);
        log('snap after session', snapAfterSession);
        log('bytes after session', bytesAfterSession);
        results.phases.snapAfterSession = snapAfterSession;
        results.phases.bytesAfterSession = bytesAfterSession;

        // Phase 3: COLD-RESTART (reload page in same context). With the
        // localStorage-backed snapshot persistence, surfaces should still
        // be warm even though the in-memory map starts empty.
        log('Phase 3: cold restart (reload)');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500); // let lifecycle settle
        await page.screenshot({ path: join(OUT, '03-after-restart.png') });

        const warmRestart = [];
        for (const s of SURFACES) {
            const r = await measure(page, s);
            warmRestart.push(r);
            log(
                '  after-restart',
                r.surface,
                'visible=' + r.visibleMs + 'ms api=' + r.apiRequestCount,
            );
        }
        results.phases.warmAfterRestart = warmRestart;
        await page.screenshot({ path: join(OUT, '04-restart-done.png') });

        // Phase 4: albums favourite filter
        log('Phase 4: albums favourite filter');
        const fav = await clickFavouriteFilter(page);
        log('fav', fav);
        results.phases.favouriteFilter = fav;
        await page.screenshot({ path: join(OUT, '05-fav-filter.png') });

        // Phase 5: large playlist simulation
        log('Phase 5: large playlist simulation');
        const playlistId = await pickPlaylistId(page);
        log('playlistId:', playlistId);
        if (playlistId) {
            const inj = await injectLargePlaylist(page, playlistId, 2000);
            log('inject:', inj);
            results.phases.largePlaylistInject = inj;
            // Reload so cache module reopens DB (closed during reload), then
            // navigate to the playlist detail page.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(2500);
            const playlistMeasure = await measure(page, {
                name: 'PlaylistDetailLarge',
                path: '#/playlists/' + playlistId + '/songs',
            });
            log('large playlist:', playlistMeasure);
            results.phases.largePlaylistMeasure = playlistMeasure;
            await page.screenshot({ path: join(OUT, '06-large-playlist.png') });
        }

        // Phase 6: final bytes + snap info
        log('Phase 6: final summary');
        results.phases.finalBytes = await bytesInfo(page);
        results.phases.finalSnap = await snapInfo(page);
        log('finalBytes', results.phases.finalBytes);
        log('finalSnap', results.phases.finalSnap);
    } catch (err) {
        results.fatal = err.message + '\n' + err.stack;
        log('FATAL:', err.message);
    } finally {
        results.cacheLogs = consoleLog
            .filter((m) => /\[cache\]|\[mutations\]|\[sync\]/.test(m.text))
            .slice(-200);
        results.errors = consoleLog.filter((m) => m.type === 'error' || m.type === 'pageerror');
        writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
        await browser.close();
        log('done at', OUT);
    }
}

async function measure(page, surface) {
    const url = BASE + '/' + surface.path;
    const reqs = [];
    const onReq = (req) => {
        const u = req.url();
        if (u.includes('demo.jellyfin.org')) reqs.push(u);
    };
    page.on('request', onReq);
    const start = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    let visibleAt = null;
    const ok = await page
        .waitForFunction(
            () => {
                const imgs = document.querySelectorAll(
                    'main img[src*="jellyfin"], main img[src^="blob:"]',
                );
                if (imgs.length > 0) return true;
                const rows = document.querySelectorAll('.ag-row, [role="row"]');
                for (const r of rows) {
                    const t = (r.textContent || '').trim();
                    if (t.length > 3) return true;
                }
                const cards = document.querySelectorAll(
                    '[class*="card"] a, [class*="grid"] a, [class*="list"] a',
                );
                for (const c of cards) {
                    const t = (c.textContent || '').trim();
                    if (t.length > 2) return true;
                }
                const main = document.querySelector('main') || document.body;
                const text = (main.textContent || '').trim();
                if (text.match(/no (results|songs|albums|artists|playlists|tracks|favorites)/i))
                    return true;
                return false;
            },
            { timeout: 12_000 },
        )
        .then(() => true)
        .catch(() => false);
    if (ok) visibleAt = Date.now() - start;
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => null);
    const end = Date.now();
    page.off('request', onReq);
    return {
        apiRequestCount: reqs.length,
        contentLoaded: ok,
        idleMs: end - start,
        path: surface.path,
        surface: surface.name,
        visibleMs: visibleAt,
    };
}

async function pickPlaylistId(page) {
    return page.evaluate(async () => {
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        const target = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
        if (!target) return null;
        return new Promise((resolve) => {
            const open = indexedDB.open(target.name);
            open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('playlists')) {
                    db.close();
                    resolve(null);
                    return;
                }
                const req = db
                    .transaction(['playlists'], 'readonly')
                    .objectStore('playlists')
                    .getAll(null, 1);
                req.onsuccess = () => {
                    const r = req.result?.[0];
                    db.close();
                    resolve(r?.Id || null);
                };
                req.onerror = () => {
                    db.close();
                    resolve(null);
                };
            };
            open.onerror = () => resolve(null);
        });
    });
}

async function snapInfo(page) {
    return page.evaluate(() => {
        try {
            const raw = localStorage.getItem('feishin:cache:snapshots:v1');
            if (!raw) return { bytes: 0, entries: 0 };
            return { bytes: raw.length, entries: (JSON.parse(raw) || []).length };
        } catch (err) {
            return { error: String(err) };
        }
    });
}

async function waitSweep(page, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (sweepWatcher.completed) return { complete: true, ms: Date.now() - start };
        if (sweepWatcher.lastEvent && Date.now() - sweepWatcher.lastEvent > 5000) {
            return { complete: false, ms: Date.now() - start, reason: 'quiet' };
        }
        await sleep(500);
    }
    return { complete: false, ms: timeoutMs, reason: 'timeout' };
}

function watchSweep(page) {
    page.on('console', (m) => {
        const t = m.text();
        if (t.includes('[cache] sweep')) sweepWatcher.lastEvent = Date.now();
        if (t.includes('hydrate: full hydration complete')) sweepWatcher.completed = true;
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
