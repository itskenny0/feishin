#!/usr/bin/env node
/*
 * Strict cold-restart measurement: counts the network API calls fired
 * after a reload and observes when the FIRST real text content appears
 * (specifically: album / artist names from the cached Dexie data). This
 * is the tight check that proves the snapshot persistence actually
 * provides warm reads — not just a fast empty-grid skeleton.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:5173';
const OUT = '/tmp/cache-verify/strict';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[strict]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildSeeded() {
    const deviceId = 'strict-' + Math.random().toString(36).slice(2);
    const auth = 'MediaBrowser Client="Feishin", Device="strict", DeviceId="' + deviceId + '", Version="1.11.0"';
    const r = await fetch('https://demo.jellyfin.org/stable/users/authenticatebyname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': auth },
        body: JSON.stringify({ Username: 'demo', Pw: '' }),
    });
    if (!r.ok) throw new Error('auth failed');
    const data = await r.json();
    const serverId = 'srv-' + Math.random().toString(36).slice(2);
    const serverItem = {
        credential: data.AccessToken, id: serverId,
        isAdmin: !!data.User.Policy?.IsAdministrator,
        name: 'Demo', type: 'jellyfin',
        url: 'https://demo.jellyfin.org/stable',
        userId: data.User.Id, username: data.User.Name, features: {},
    };
    const storeAuth = { state: { currentServer: serverItem, deviceId, serverList: { [serverId]: serverItem } }, version: 2 };
    return { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'store_authentication', value: JSON.stringify(storeAuth) }] }] };
}

const sweepWatcher = { lastEvent: 0, completed: false };
function watchSweep(page) {
    page.on('console', (m) => {
        const t = m.text();
        if (t.includes('[cache] sweep')) sweepWatcher.lastEvent = Date.now();
        if (t.includes('hydrate: full hydration complete')) sweepWatcher.completed = true;
    });
}
async function waitSweep(page, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (sweepWatcher.completed) return { complete: true };
        if (sweepWatcher.lastEvent && Date.now() - sweepWatcher.lastEvent > 5000) return { complete: false, reason: 'quiet' };
        await sleep(500);
    }
    return { complete: false, reason: 'timeout' };
}

async function enableAndHydrate(page) {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    const enable = page.locator('button:has-text("Enable now")').first();
    if (await enable.isVisible().catch(() => false)) {
        await enable.click();
        await sleep(1500);
    }
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
        const btn = page.locator('button:has-text("Sync now")').first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            break;
        }
        await sleep(500);
    }
    return waitSweep(page, 60_000);
}

async function readKnownAlbumName(page) {
    return page.evaluate(async () => {
        const dbs = await indexedDB.databases();
        const target = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
        if (!target) return null;
        return new Promise((resolve) => {
            const open = indexedDB.open(target.name);
            open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('albums')) { db.close(); resolve(null); return; }
                const req = db.transaction(['albums'], 'readonly').objectStore('albums').getAll(null, 1);
                req.onsuccess = () => { const r = req.result?.[0]; db.close(); resolve(r?.Payload?.name || r?.SortName || null); };
                req.onerror = () => { db.close(); resolve(null); };
            };
            open.onerror = () => resolve(null);
        });
    });
}

async function measureStrict(page, surface, knownText) {
    const url = BASE + '/' + surface.path;
    const reqs = [];
    const onReq = (req) => {
        const u = req.url();
        if (u.includes('demo.jellyfin.org') && (u.includes('/Items') || u.includes('/Users/') || u.includes('/Playlists'))) {
            reqs.push(u);
        }
    };
    page.on('request', onReq);
    const start = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Wait for the KNOWN text from cache to appear in the visible DOM.
    let knownTextAt = null;
    if (knownText) {
        try {
            await page.waitForFunction((text) => {
                const main = document.querySelector('main') || document.body;
                return (main.textContent || '').includes(text);
            }, knownText, { timeout: 10_000 });
            knownTextAt = Date.now() - start;
        } catch {}
    }
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => null);
    const idleAt = Date.now() - start;
    page.off('request', onReq);
    return {
        surface: surface.name,
        knownText,
        knownTextAt,
        idleAt,
        apiCount: reqs.length,
        apiSample: reqs.slice(0, 3),
    };
}

async function main() {
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const seeded = await buildSeeded();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: seeded });
    const page = await context.newPage();
    const consoleLog = [];
    page.on('console', (m) => consoleLog.push({ type: m.type(), text: m.text() }));
    watchSweep(page);

    const results = { startedAt: new Date().toISOString() };
    try {
        log('Phase 1: hydrate');
        results.hydrate = await enableAndHydrate(page);
        log('hydrate:', results.hydrate);

        const albumName = await readKnownAlbumName(page);
        log('known album name:', albumName);
        results.knownAlbumName = albumName;

        // Phase 2: warm same session
        log('Phase 2: warm session');
        const warmSession = [];
        warmSession.push(await measureStrict(page, { name: 'Albums', path: '#/library/albums' }, albumName));
        warmSession.push(await measureStrict(page, { name: 'Artists', path: '#/library/album-artists' }));
        warmSession.push(await measureStrict(page, { name: 'Playlists', path: '#/playlists' }));
        results.warmSession = warmSession;
        log('warmSession:', warmSession);
        await page.screenshot({ path: join(OUT, 'obs-1-warm-session-albums.png') });

        // Phase 3: cold restart (reload)
        log('Phase 3: cold restart');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(3000);
        const restart = [];
        restart.push(await measureStrict(page, { name: 'Albums', path: '#/library/albums' }, albumName));
        await page.screenshot({ path: join(OUT, 'obs-1-warm-after-restart-albums.png') });
        restart.push(await measureStrict(page, { name: 'Artists', path: '#/library/album-artists' }));
        await page.screenshot({ path: join(OUT, 'obs-1-warm-after-restart-artists.png') });
        restart.push(await measureStrict(page, { name: 'Playlists', path: '#/playlists' }));
        await page.screenshot({ path: join(OUT, 'obs-1-warm-after-restart-playlists.png') });
        results.afterRestart = restart;
        log('afterRestart:', restart);

        // Phase 4: pick first playlist, drill in. The detail+songs come
        // from Dexie via the cache fast-path.
        const playlistId = await page.evaluate(async () => {
            const dbs = await indexedDB.databases();
            const target = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
            if (!target) return null;
            return new Promise((resolve) => {
                const open = indexedDB.open(target.name);
                open.onsuccess = () => {
                    const db = open.result;
                    const req = db.transaction(['playlists'], 'readonly').objectStore('playlists').getAll(null, 1);
                    req.onsuccess = () => { const r = req.result?.[0]; db.close(); resolve({ id: r?.Id, name: r?.Payload?.name }); };
                    req.onerror = () => { db.close(); resolve(null); };
                };
                open.onerror = () => resolve(null);
            });
        });
        log('playlistId:', playlistId);
        if (playlistId?.id) {
            const playlistDetail = await measureStrict(page, {
                name: 'PlaylistDetail',
                path: '#/playlists/' + playlistId.id + '/songs',
            }, playlistId.name);
            results.playlistDetail = playlistDetail;
            log('playlistDetail:', playlistDetail);
            await page.screenshot({ path: join(OUT, 'obs-4-playlist-detail.png') });
        }

        // Phase 5: favourites filter direct via URL with injected favs
        // First inject favourites for some album IDs
        const fav = await page.evaluate(async () => {
            const dbs = await indexedDB.databases();
            const target = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
            if (!target) return { error: 'no db' };
            return new Promise((resolve) => {
                const open = indexedDB.open(target.name);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction(['albums', 'favorites'], 'readwrite');
                    const a = tx.objectStore('albums').getAll(null, 2);
                    a.onsuccess = () => {
                        const ids = (a.result || []).map((r) => r.Id);
                        const now = Date.now();
                        for (const id of ids) {
                            tx.objectStore('favorites').put({
                                __cachedAt: now, IsFavorite: true, ItemId: id, ItemType: 'Album',
                                LastPlayedDate: undefined, PlayCount: 0, Rating: undefined,
                            });
                        }
                        tx.oncomplete = () => { db.close(); resolve({ added: ids.length, ids }); };
                        tx.onerror = () => { db.close(); resolve({ error: 'tx failed' }); };
                    };
                };
                open.onerror = () => resolve({ error: 'open failed' });
            });
        });
        log('favorites injected:', fav);
        results.favInject = fav;

        // Navigate with ?favorite=true and capture cache logs around the call
        const baselineLogCount = consoleLog.length;
        const favMeasure = await measureStrict(page, {
            name: 'AlbumsFavourite',
            path: '#/library/albums?favorite=true',
        });
        results.favouriteMeasure = favMeasure;
        log('favourite filter measure:', favMeasure);
        await page.screenshot({ path: join(OUT, 'obs-2-fav-filter.png') });
        // Capture the filter:albums log lines that mention hits
        const filterLogs = consoleLog.slice(baselineLogCount).filter((m) =>
            /filter: albums|filter: artists/.test(m.text)
        );
        results.favFilterLogs = filterLogs.map((l) => l.text);
        log('filter logs after favourite:', results.favFilterLogs);
    } catch (err) {
        results.fatal = err.message + '\n' + err.stack;
        log('FATAL:', err.message);
    } finally {
        results.cacheLogs = consoleLog.filter((m) => /\[cache\]/.test(m.text)).slice(-50).map((m) => m.text);
        results.errors = consoleLog.filter((m) => m.type === 'error' || m.type === 'pageerror').map((m) => m.text);
        writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
        await browser.close();
        log('done at', OUT);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
