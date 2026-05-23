#!/usr/bin/env node
/*
 * Production-build runtime verification of the local-first Jellyfin cache.
 *
 * Phases (all run in one Chromium context to share IndexedDB across loads):
 *  0. Boot + CORS shim against demo.jellyfin.org
 *  1. Server add (form-fill) + opt-in modal + hydration sweep
 *  2. Cold-load measurement (cache OFF via master toggle)
 *  3. Warm-load measurement (cache ON, fully hydrated)
 *  4. Favourite toggle frame latency
 *  5. Search-as-you-type render latency
 *  6. Sync-chip rAF interpolation under throttled responses
 *
 * Output: /tmp/cache-verify/results.json + per-step screenshots.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:5173';
const DEMO = 'https://demo.jellyfin.org/stable/';
const OUT = '/tmp/cache-verify';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORT = { width: 1440, height: 900 };

const SURFACES = [
    { name: 'Home', path: '#/', waitFor: 'main' },
    { name: 'Albums', path: '#/library/albums', waitFor: 'main' },
    { name: 'Artists', path: '#/library/album-artists', waitFor: 'main' },
    { name: 'Songs', path: '#/library/songs', waitFor: 'main' },
    { name: 'Playlists', path: '#/playlists', waitFor: 'main' },
    { name: 'Favorites', path: '#/favorites', waitFor: 'main' },
    { name: 'Search', path: '#/search/album?query=sym', waitFor: 'main' },
    // Album detail + Artist detail + Playlist detail are filled in dynamically
    // after we read IDs from the cache.
];

let CORS_DELAY_MS = 0; // For Phase 6 throttling

async function buildContext(browser, storageState) {
    const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        ...(storageState ? { storageState } : {}),
    });

    // CORS shim — demo.jellyfin.org doesn't allow http://127.0.0.1 origins
    // by default. Mutate response headers so the renderer accepts them.
    await context.route('https://demo.jellyfin.org/**', async (route) => {
        if (CORS_DELAY_MS > 0) await sleep(CORS_DELAY_MS);
        try {
            const response = await route.fetch();
            const baseHeaders = response.headers();
            const headers = {
                ...baseHeaders,
                'access-control-allow-origin': '*',
                'access-control-allow-credentials': 'true',
                'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS,PATCH',
                'access-control-allow-headers': '*',
                'access-control-expose-headers': '*',
            };
            // Preflight (OPTIONS) sometimes needs a synthetic 200.
            if (route.request().method() === 'OPTIONS') {
                await route.fulfill({ status: 200, headers, body: '' });
                return;
            }
            await route.fulfill({ response, headers });
        } catch (e) {
            try { await route.continue(); } catch { /* ignored */ }
        }
    });

    return context;
}

async function buildSeededStorageState() {
    // Auth against the demo server directly from Node — no CORS issues here.
    const deviceId = 'feishin-verify-' + Math.random().toString(36).slice(2);
    const auth =
        'MediaBrowser Client="Feishin", Device="cache-verify", DeviceId="' +
        deviceId +
        '", Version="1.11.0"';
    const r = await fetch('https://demo.jellyfin.org/stable/users/authenticatebyname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': auth },
        body: JSON.stringify({ Username: 'demo', Pw: '' }),
    });
    if (!r.ok) throw new Error('auth failed: ' + r.status);
    const data = await r.json();
    const serverId = 'srv-' + Math.random().toString(36).slice(2);
    const serverItem = {
        credential: data.AccessToken,
        id: serverId,
        isAdmin: !!data.User.Policy?.IsAdministrator,
        name: 'Demo',
        type: 'jellyfin',
        url: 'https://demo.jellyfin.org/stable',
        userId: data.User.Id,
        username: data.User.Name,
        features: {},
    };
    const storeAuth = {
        state: {
            currentServer: serverItem,
            deviceId,
            serverList: { [serverId]: serverItem },
        },
        version: 2,
    };
    return {
        cookies: [],
        origins: [
            {
                origin: 'http://127.0.0.1:5173',
                localStorage: [
                    { name: 'store_authentication', value: JSON.stringify(storeAuth) },
                ],
            },
        ],
    };
}

async function loginViaForm(page) {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    // Wait for the form to mount.
    await page.waitForTimeout(3000);
    // If we're not on action-required, we're already logged in.
    if (!page.url().includes('action-required') && !(await page.getByText(/server required/i).first().isVisible().catch(() => false))) {
        log('login: already logged in');
        return page.url();
    }
    // Click the Jellyfin segment to make sure type is Jellyfin (Navidrome is default).
    const jelly = page.getByText(/^Jellyfin$/).first();
    if (await jelly.isVisible().catch(() => false)) {
        await jelly.click();
        await sleep(400);
    }
    // Count actual rendered <input> elements (excluding hidden/checkbox/radio).
    const inputs = page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    const count = await inputs.count();
    log('login: inputs visible =', count);
    if (count < 3) {
        log('login: form did not render expected fields');
        await page.screenshot({ path: join(OUT, 'login-fail.png') });
        return page.url();
    }
    // Fill via positional input access — Mantine labels can drift.
    //   0: name, 1: url, 2: remoteUrl, 3: username, 4: password (input)
    await inputs.nth(0).fill('Demo');
    await inputs.nth(1).fill('https://demo.jellyfin.org/stable');
    // skip remoteUrl
    await inputs.nth(3).fill('demo');
    // password (index 4) left empty.
    // Click submit. The button reads "ADD" (uppercase by CSS) but text content is "Add".
    const submit = page.locator('button[type="submit"]').last();
    await submit.click();
    // Wait for redirect away from action-required.
    try {
        await page.waitForFunction(() => !location.hash.includes('action-required'), null, { timeout: 30_000 });
    } catch {
        log('login: did not navigate; capturing screenshot');
        await page.screenshot({ path: join(OUT, 'login-stuck.png') });
    }
    return page.url();
}

async function dismissOptInEnable(page) {
    // Modal has buttons "Set up later" and "Enable now" (i18n default).
    await page.waitForTimeout(2000);
    // Dismiss any toast that may be overlaying the modal.
    const toastClose = page.locator('button[aria-label="Close notification" i], button[aria-label*="close" i]').first();
    if (await toastClose.isVisible().catch(() => false)) {
        await toastClose.click().catch(() => {});
        await sleep(300);
    }
    // Use plain text match on the button — Mantine's Modal doesn't expose
    // role="dialog" reliably across versions.
    const enable = page.locator('button:has-text("Enable now")').first();
    const visible = await enable.isVisible().catch(() => false);
    if (visible) {
        await enable.scrollIntoViewIfNeeded().catch(() => {});
        await enable.click();
        log('opt-in: clicked Enable');
        await sleep(1500);
        return true;
    }
    log('opt-in: modal not visible (no Enable button)');
    return false;
}

async function acceptHydrationBanner(page) {
    // Wait briefly, then force a remount of HomeRoute (and thus
    // HydrationBanner) by navigating away and back. This sidesteps a
    // race in the banner's effect where cacheAvailable can flip true
    // *before* setActiveCacheDb has set the active DB handle — the
    // banner then reads `getActiveCacheDb()` as undefined, sets
    // shouldShow=false and never re-evaluates because activeServer
    // isn't in its deps array.
    await sleep(2500);
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    for (let i = 0; i < 24; i++) {
        const btn = page.locator('button:has-text("Sync now")').first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            log('hydration: clicked Sync now');
            return true;
        }
        await sleep(500);
    }
    // Capture state and fall back to navigating directly to the syncMeta
    // and triggering hydrate via the dashboard if it's reachable.
    await page.screenshot({ path: join(OUT, '03b-banner-missing.png') });
    log('hydration: banner did not appear after remount');
    return false;
}

// Shared mutable sweep watcher state. Subscribed once at boot.
const sweepWatcher = { lastEventAt: 0, totalEvents: 0, hydrateCompleteAt: 0 };

function installSweepWatcher(page) {
    page.on('console', (m) => {
        const t = m.text();
        if (t.includes('[cache] sweep')) {
            sweepWatcher.lastEventAt = Date.now();
            sweepWatcher.totalEvents++;
        }
        if (t.includes('hydrate: full hydration complete')) {
            sweepWatcher.hydrateCompleteAt = Date.now();
        }
    });
}

async function waitForSweepIdle(page, timeoutMs = 90_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (sweepWatcher.hydrateCompleteAt > t0) {
            return { wallMs: Date.now() - t0, sweepEvents: sweepWatcher.totalEvents, complete: true };
        }
        // Fallback: 5 seconds of quiet AND we've seen at least one event.
        if (sweepWatcher.totalEvents > 0 && Date.now() - sweepWatcher.lastEventAt > 5000) {
            return { wallMs: Date.now() - t0, sweepEvents: sweepWatcher.totalEvents, complete: false, reason: 'quiet' };
        }
        await sleep(500);
    }
    return { wallMs: timeoutMs, sweepEvents: sweepWatcher.totalEvents, complete: false, reason: 'timeout' };
}

async function readSyncMetaSummary(page) {
    return await page.evaluate(async () => {
        try {
            const req = indexedDB.databases ? await indexedDB.databases() : [];
            const dbInfos = req.map((d) => d.name).filter(Boolean);
            const out = { dbs: dbInfos, perDb: {} };
            for (const name of dbInfos) {
                if (!String(name).startsWith('feishin-cache')) continue;
                await new Promise((res) => {
                    const open = indexedDB.open(name);
                    open.onsuccess = () => {
                        const db = open.result;
                        if (!db.objectStoreNames.contains('syncMeta')) { db.close(); res(); return; }
                        const tx = db.transaction(['syncMeta'], 'readonly');
                        const req2 = tx.objectStore('syncMeta').getAll();
                        req2.onsuccess = () => {
                            out.perDb[name] = req2.result.map((r) => ({
                                entity: r.EntityType,
                                state: r.hydrationState,
                                count: r.itemCount ?? r.count,
                            }));
                            db.close();
                            res();
                        };
                        req2.onerror = () => { db.close(); res(); };
                    };
                    open.onerror = () => res();
                });
            }
            return out;
        } catch (e) {
            return { error: String(e) };
        }
    });
}

async function readEntityCountsFromIDB(page) {
    return await page.evaluate(async () => {
        try {
            const dbsList = indexedDB.databases ? await indexedDB.databases() : [];
            const out = {};
            for (const d of dbsList) {
                const name = d.name || '';
                if (!String(name).startsWith('feishin-cache')) continue;
                await new Promise((res) => {
                    const open = indexedDB.open(name);
                    open.onsuccess = () => {
                        const db = open.result;
                        const stores = ['albums', 'artists', 'songs', 'genres', 'playlists', 'favorites'];
                        const counts = {};
                        let pending = stores.length;
                        for (const s of stores) {
                            if (!db.objectStoreNames.contains(s)) {
                                counts[s] = 0;
                                pending--;
                                if (pending === 0) { db.close(); out[name] = counts; res(); }
                                continue;
                            }
                            const r = db.transaction([s], 'readonly').objectStore(s).count();
                            r.onsuccess = () => { counts[s] = r.result; pending--; if (pending === 0) { db.close(); out[name] = counts; res(); } };
                            r.onerror = () => { counts[s] = -1; pending--; if (pending === 0) { db.close(); out[name] = counts; res(); } };
                        }
                    };
                    open.onerror = () => res();
                });
            }
            return out;
        } catch (e) {
            return { error: String(e) };
        }
    });
}

async function pickIdsFromIDB(page) {
    return await page.evaluate(async () => {
        const out = { albumId: null, artistId: null, playlistId: null };
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        for (const d of dbs) {
            const name = d.name || '';
            if (!String(name).startsWith('feishin-cache')) continue;
            await new Promise((res) => {
                const open = indexedDB.open(name);
                open.onsuccess = () => {
                    const db = open.result;
                    const fetchOne = (store) => new Promise((r) => {
                        if (!db.objectStoreNames.contains(store)) { r(null); return; }
                        const req = db.transaction([store], 'readonly').objectStore(store).getAll(null, 1);
                        req.onsuccess = () => r(req.result && req.result[0] ? req.result[0] : null);
                        req.onerror = () => r(null);
                    });
                    Promise.all([fetchOne('albums'), fetchOne('artists'), fetchOne('playlists')]).then(([a, ar, p]) => {
                        if (a && !out.albumId) out.albumId = a.Id || a.id;
                        if (ar && !out.artistId) out.artistId = ar.Id || ar.id;
                        if (p && !out.playlistId) out.playlistId = p.Id || p.id;
                        db.close();
                        res();
                    }, () => { db.close(); res(); });
                };
                open.onerror = () => res();
            });
        }
        return out;
    });
}

async function measureSurface(page, surface) {
    const url = BASE + '/' + surface.path;
    // Track network requests during this nav, restricted to jellyfin API.
    const reqs = [];
    const onReq = (req) => {
        const u = req.url();
        if (u.includes('demo.jellyfin.org')) reqs.push(u);
    };
    page.on('request', onReq);
    const start = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // "Content visible" timestamp — when the user sees something useful.
    let visibleAt = null;
    const visibleOk = await page.waitForFunction(() => {
        // Any img with a src pointing at jellyfin = data has loaded.
        const imgs = document.querySelectorAll('main img[src*="jellyfin"], main img[src^="blob:"], main img[src^="data:"]');
        if (imgs.length > 0) return true;
        // ag-grid rows with real text content (not empty placeholders).
        const rows = document.querySelectorAll('.ag-row, [role="row"]');
        for (const r of rows) {
            const t = (r.textContent || '').trim();
            if (t.length > 3) return true;
        }
        // Visible cards / list-items.
        const cards = document.querySelectorAll('[class*="card"] a, [class*="grid"] a, [class*="list"] a');
        for (const c of cards) {
            const t = (c.textContent || '').trim();
            if (t.length > 2) return true;
        }
        // Empty-state copy.
        const main = document.querySelector('main') || document.body;
        const text = (main.textContent || '').trim();
        if (text.match(/no (results|songs|albums|artists|playlists|tracks|favorites)/i)) return true;
        return false;
    }, { timeout: 15_000 }).then(() => true).catch(() => false);
    if (visibleOk) visibleAt = Date.now() - start;
    // Now wait for network idle so the request count is accurate.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);
    const end = Date.now();
    page.off('request', onReq);
    return {
        surface: surface.name,
        path: surface.path,
        visibleMs: visibleAt,
        idleMs: end - start,
        contentLoaded: visibleOk,
        apiRequestCount: reqs.length,
    };
}

async function setMasterToggle(page, on) {
    // Drive it deterministically by writing to the settings store via
    // localStorage. The lifecycle hook subscribes to `localCache.enabled`,
    // so flipping the persisted value and waiting a tick is enough.
    const before = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('store_settings') || '{}'); } catch { return null; }
    });
    const ok = await page.evaluate((next) => {
        try {
            const raw = localStorage.getItem('store_settings');
            const parsed = raw ? JSON.parse(raw) : { state: {}, version: 1 };
            parsed.state = parsed.state || {};
            parsed.state.localCache = { ...(parsed.state.localCache || {}), enabled: next };
            localStorage.setItem('store_settings', JSON.stringify(parsed));
            return true;
        } catch (e) {
            return String(e);
        }
    }, on);
    log('master toggle: wrote', on, 'ok=', ok);
    // Reload so the lifecycle picks up the new setting cleanly.
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    // Verify.
    const verified = await page.evaluate(() => {
        try {
            const raw = JSON.parse(localStorage.getItem('store_settings') || '{}');
            return raw?.state?.localCache?.enabled;
        } catch { return null; }
    });
    log('master toggle: verified value=', verified);
    return verified === on;
}

async function measureFavouriteToggle(page, albumId) {
    if (!albumId) return { error: 'no album id' };
    await page.goto(BASE + '/#/library/albums/' + albumId, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    // Find any favourite button. The library-header has aria-label="Favorite".
    // Failing that, an icon-button containing a heart svg.
    const sels = [
        'button[aria-label="Favorite"]',
        'button[aria-label*="favorite" i]',
        'button[aria-label*="favourite" i]',
        'button[title*="favorite" i]',
    ];
    let foundSel = null;
    for (const s of sels) {
        const el = page.locator(s).first();
        if (await el.isVisible().catch(() => false)) { foundSel = s; break; }
    }
    if (!foundSel) return { error: 'no favourite button found', tried: sels };
    const ms = await page.evaluate(async (sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return -1;
        const t0 = performance.now();
        btn.click();
        await new Promise((r) => requestAnimationFrame(() => r()));
        return performance.now() - t0;
    }, foundSel);
    return { ms: Math.round(ms * 100) / 100, selector: foundSel };
}

async function measureSearchAsYouType(page) {
    // Navigate to a known route first so the search input is reachable via URL.
    // Then directly drive the URL hash query param and time the render delta
    // for each keystroke equivalent.
    const keystrokes = ['s', 'y', 'm'];
    const samples = [];
    for (let i = 0; i < keystrokes.length; i++) {
        const q = keystrokes.slice(0, i + 1).join('');
        const t0 = await page.evaluate(() => performance.now());
        await page.goto(BASE + '/#/search/album?query=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded' });
        // Wait until at least one row OR an "empty state" message renders.
        await page.waitForFunction(() => {
            const m = document.querySelector('main');
            if (!m) return false;
            // any text after a navigation counts; we wait for at least one
            // visible child with non-empty text or a row.
            return m.textContent && m.textContent.length > 50;
        }, { timeout: 5000 }).catch(() => null);
        const t1 = await page.evaluate(() => performance.now());
        samples.push({ q, ms: Math.round(t1 - t0) });
    }
    return samples;
}

async function measureSyncChipRAF(page) {
    // Throttle Jellyfin responses by 800ms then trigger a re-sync. The
    // demo library is tiny (~4 albums), so we need a meaningful delay
    // for the chip to be visible long enough to sample.
    CORS_DELAY_MS = 800;
    log('rAF: enabled 800ms response delay');
    // Trigger a re-sync via direct localStorage manipulation: clear
    // syncMeta and re-mount home. Easier: just write to IndexedDB then
    // reload to fire a fresh sweep.
    await page.evaluate(async () => {
        // Wipe syncMeta so the hydration banner reappears on home.
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        for (const d of dbs) {
            const name = d.name || '';
            if (!String(name).startsWith('feishin-cache')) continue;
            await new Promise((res) => {
                const open = indexedDB.open(name);
                open.onsuccess = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains('syncMeta')) { db.close(); res(); return; }
                    const tx = db.transaction(['syncMeta'], 'readwrite');
                    tx.objectStore('syncMeta').clear();
                    tx.oncomplete = () => { db.close(); res(); };
                    tx.onerror = () => { db.close(); res(); };
                };
                open.onerror = () => res();
            });
        }
        // Clear the per-server "banner dismissed" flag so it can show again.
        try {
            for (const k of Object.keys(sessionStorage)) {
                if (k.startsWith('feishin:hydration-banner-dismissed')) sessionStorage.removeItem(k);
            }
        } catch {}
    });
    // Go to home so the hydration banner mounts.
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    // Navigate away and back (workaround for the activeServer-vs-cacheAvailable
    // race we hit earlier in Phase 1).
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(800);
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(800);
    // Start sampling IMMEDIATELY when the click fires so we capture the
    // earlier (heavier) sweeps too. Use a background polling loop.
    const samples = [];
    const t0 = Date.now();
    let sampling = true;
    const samplerPromise = (async () => {
        while (sampling && Date.now() - t0 < 10000) {
            try {
                const text = await page.evaluate(() => {
                    const headers = document.querySelectorAll('header, [class*="LibraryHeaderBar"], [class*="library-header"]');
                    for (const h of headers) {
                        const t = (h.textContent || '').trim();
                        if (t.includes('Syncing') || /\d+\s*\/\s*\d+/.test(t)) return t;
                    }
                    return null;
                });
                if (text) {
                    const pair = (text.match(/([\d,]+)\s*\/\s*([\d,]+)/) || [null])[0];
                    const bytes = (text.match(/[\d.]+\s*(?:B|KB|KiB|MB|MiB|GB)\s*\/?/g) || []).join(' | ');
                    const items = (text.match(/Syncing \w+ · ([\d,]+)/) || [null, null])[1];
                    samples.push({ t: Date.now() - t0, text: text.slice(0, 200), pair, bytes, items });
                }
            } catch { /* page closing */ }
            await sleep(50);
        }
    })();
    const sync = page.locator('button:has-text("Sync now")').first();
    if (await sync.isVisible().catch(() => false)) {
        await sync.click();
        log('rAF: triggered hydrate via banner Sync now');
    } else {
        log('rAF: banner Sync now not visible; chip won\'t fire');
    }
    // Wait the full sampling window so the chip is captured throughout.
    while (Date.now() - t0 < 10000) {
        await sleep(200);
    }
    sampling = false;
    await samplerPromise.catch(() => null);
    CORS_DELAY_MS = 0;
    log('rAF: disabled response delay');
    const uniquePairs = new Set(samples.map((s) => s.pair).filter(Boolean));
    const uniqueBytes = new Set(samples.map((s) => s.bytes).filter(Boolean));
    const uniqueItems = new Set(samples.map((s) => s.items).filter(Boolean));
    return {
        samples: samples.length,
        uniquePairCount: uniquePairs.size,
        uniqueBytesCount: uniqueBytes.size,
        uniqueItemsCount: uniqueItems.size,
        examples: samples.slice(0, 30),
        sampleEvery: '50ms',
        responseDelay: '800ms',
    };
}

async function main() {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    log('Authenticating against demo server (Node fetch)...');
    const seeded = await buildSeededStorageState();
    log('Auth OK');

    const results = { startedAt: new Date().toISOString(), phases: {} };
    const allConsole = [];

    // --- PHASE 2 first: COLD MEASUREMENT, ONE FRESH CONTEXT PER SURFACE ---
    // We do this BEFORE enabling the cache so the IndexedDB cache is inert.
    // Each surface gets its own context so React Query can't reuse data
    // across surfaces — the cold reading honestly reflects "what would a
    // new user see opening the app and tapping this tab".
    log('Phase 2: COLD measurement, fresh context per surface');
    const measureColdSurface = async (surface, opts = {}) => {
        // Seed an extra localStorage entry that pre-dismisses the opt-in
        // modal so it doesn't gate the measurement. We pre-write
        // `store_settings` with `localCache.enabled: false` — that's the
        // "Set up later" outcome — so the cache subsystem stays inert and
        // the surface MUST hit the network.
        const coldState = JSON.parse(JSON.stringify(seeded));
        coldState.origins[0].localStorage.push({
            name: 'store_settings',
            value: JSON.stringify({
                state: { localCache: { enabled: false } },
                version: 1,
            }),
        });
        const cctx = await buildContext(browser, coldState);
        const cpage = await cctx.newPage();
        cpage.on('console', (m) => allConsole.push({ phase: 'cold', type: m.type(), text: m.text() }));
        // Navigate DIRECTLY to the surface — no home pre-warm.
        const r = await measureSurface(cpage, surface);
        log('  cold', r.surface, 'visible=' + r.visibleMs + 'ms', 'idle=' + r.idleMs + 'ms', r.apiRequestCount + 'api');
        if (opts.screenshot) await cpage.screenshot({ path: join(OUT, opts.screenshot) });
        await cctx.close();
        return r;
    };
    const cold = [];
    for (const s of SURFACES) {
        cold.push(await measureColdSurface(s));
    }
    results.phases.phase2_cold = cold;

    // --- PHASE 1: opt-in + hydration in a fresh context (warm session begins) ---
    log('Phase 1: opt-in + hydrate in a fresh context');
    const context = await buildContext(browser, seeded);
    const page = await context.newPage();
    page.on('console', (m) => allConsole.push({ phase: 'warm', type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => allConsole.push({ phase: 'warm', type: 'pageerror', text: e.message }));
    installSweepWatcher(page);

    try {
        // --- PHASE 1 ---
        await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await page.screenshot({ path: join(OUT, '01-loggedin.png') });
        // Diagnostic: dump cache-related state.
        const lsDump1 = await page.evaluate(async () => ({
            auth: JSON.parse(localStorage.getItem('store_authentication') || 'null'),
            settings: JSON.parse(localStorage.getItem('store_settings') || 'null'),
            dbs: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [],
        }));
        log('LS auth currentServer:', lsDump1.auth?.state?.currentServer?.id, 'userId:', lsDump1.auth?.state?.currentServer?.userId);
        log('LS settings localCache:', JSON.stringify(lsDump1.settings?.state?.localCache));
        const optInClicked = await dismissOptInEnable(page);
        await page.screenshot({ path: join(OUT, '02-after-opt-in.png') });
        const lsDump2 = await page.evaluate(() => ({
            settings: JSON.parse(localStorage.getItem('store_settings') || 'null'),
        }));
        log('After opt-in: settings localCache:', JSON.stringify(lsDump2.settings?.state?.localCache));
        const hydrationAccepted = await acceptHydrationBanner(page);
        await page.screenshot({ path: join(OUT, '03-after-hydration-banner.png') });
        const sweepWallMs = await waitForSweepIdle(page, 90_000);
        await page.screenshot({ path: join(OUT, '04-sweep-done.png') });
        const counts = await readEntityCountsFromIDB(page);
        const meta = await readSyncMetaSummary(page);
        results.phases.phase1 = {
            optInClicked,
            hydrationAccepted,
            sweepWallMs,
            entityCounts: counts,
            syncMeta: meta,
        };
        log('Phase 1 done: sweep wall', sweepWallMs, 'ms');

        // Pick representative IDs for detail pages.
        const ids = await pickIdsFromIDB(page);
        log('IDs from IDB:', ids);
        const detailSurfaces = [];
        if (ids.albumId) {
            detailSurfaces.push({ name: 'AlbumDetail', path: '#/library/albums/' + ids.albumId });
        }
        if (ids.artistId) {
            detailSurfaces.push({ name: 'ArtistDetail', path: '#/library/album-artists/' + ids.artistId });
        }
        if (ids.playlistId) {
            detailSurfaces.push({ name: 'PlaylistDetail', path: '#/playlists/' + ids.playlistId + '/songs' });
        }
        results.detailSurfaces = detailSurfaces;

        const allSurfaces = [...SURFACES, ...detailSurfaces];

        // --- PHASE 3 (warm) ---
        log('Phase 3: warm-load measurement (cache ON, fully hydrated)');
        await page.screenshot({ path: join(OUT, '06-cache-on.png') });
        const warm = [];
        for (const s of allSurfaces) {
            const r = await measureSurface(page, s);
            log('  warm', r.surface, 'visible=' + r.visibleMs + 'ms', 'idle=' + r.idleMs + 'ms', r.apiRequestCount + 'api');
            warm.push(r);
        }
        results.phases.phase3_warm = warm;

        // Re-run detail-page COLD measurements in their own fresh contexts
        // now that we know the IDs. This makes the cold/warm comparison fair
        // for the detail pages too.
        log('Phase 2b: cold detail-page measurements in fresh contexts');
        const phase2bDetail = [];
        for (const s of detailSurfaces) {
            phase2bDetail.push(await measureColdSurface(s));
        }
        results.phases.phase2b_cold_detail = phase2bDetail;

        // --- PHASE 4 (favourite toggle) ---
        log('Phase 4: favourite toggle latency');
        const fav = await measureFavouriteToggle(page, ids.albumId);
        results.phases.phase4_favourite = fav;
        log('  fav', fav);

        // --- PHASE 5 (search) ---
        log('Phase 5: search-as-you-type latency');
        const search = await measureSearchAsYouType(page);
        results.phases.phase5_search = search;
        log('  search samples', search);

        // --- PHASE 6 (rAF chip) ---
        log('Phase 6: sync-chip rAF interpolation');
        const raf = await measureSyncChipRAF(page);
        results.phases.phase6_raf = raf;
        log('  raf', { samples: raf.samples, uniquePairCount: raf.uniquePairCount });

    } catch (err) {
        results.fatal = err.message + '\n' + err.stack;
        log('FATAL:', err.message);
    } finally {
        results.console = allConsole;
        results.endedAt = new Date().toISOString();
        writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
        await browser.close();
        log('done; results saved to', join(OUT, 'results.json'));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
