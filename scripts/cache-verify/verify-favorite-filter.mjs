#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/*
 * Focused verification for observation #2: "Albums view with favourites
 * filter set to on loads with a spinner."
 *
 * Strategy:
 *  1. Boot + opt-in + hydrate so Dexie has albums.
 *  2. Inject a few CachedFavorite rows referencing real album IDs in
 *     Dexie (the demo server may have zero favorites by default).
 *  3. Drive the Jellyfin album filter UI: open the popover, set the
 *     "Is favorited" segmented control to "Yes", close.
 *  4. Measure how long the grid takes to show content.
 *
 * Pre-fix this would show a spinner indefinitely because:
 *   - readAlbumsFromCache never passed favoriteAlbumIds → filter returned
 *     undefined → fell back to network for unfiltered list.
 *   - readFavoriteArtistIds.where('ItemType') threw a SchemaError.
 *
 * Post-fix the favourites are read via .filter(), passed through, and
 * the grid paints from the cache.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5173';
const OUT = '/tmp/cache-verify/fav-filter';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[fav-verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildSeeded() {
    const deviceId = 'fav-verify-' + Math.random().toString(36).slice(2);
    const auth =
        'MediaBrowser Client="Feishin", Device="fav-verify", DeviceId="' +
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

const sweepWatcher = { completed: false, lastEvent: 0 };
async function clickEnableNow(page) {
    await sleep(2000);
    const enable = page.locator('button:has-text("Enable now")').first();
    if (await enable.isVisible().catch(() => false)) {
        await enable.click();
        await sleep(1500);
        return true;
    }
    return false;
}
async function clickSyncNow(page) {
    await sleep(2500);
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
        const btn = page.locator('button:has-text("Sync now")').first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            return true;
        }
        await sleep(500);
    }
    return false;
}

async function injectAlbumFavorites(page, n) {
    return page.evaluate(
        async ({ n }) => {
            const dbs = await indexedDB.databases();
            const target = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
            if (!target) return { error: 'no db' };
            return new Promise((resolve) => {
                const open = indexedDB.open(target.name);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction(['albums', 'favorites'], 'readwrite');
                    const albumsStore = tx.objectStore('albums');
                    const favStore = tx.objectStore('favorites');
                    const req = albumsStore.getAll(null, n);
                    req.onsuccess = () => {
                        const albums = req.result || [];
                        const now = Date.now();
                        for (const a of albums) {
                            favStore.put({
                                __cachedAt: now,
                                IsFavorite: true,
                                ItemId: a.Id,
                                ItemType: 'Album',
                                LastPlayedDate: undefined,
                                PlayCount: 0,
                                Rating: undefined,
                            });
                        }
                        tx.oncomplete = () => {
                            db.close();
                            resolve({ added: albums.length, ids: albums.map((a) => a.Id) });
                        };
                        tx.onerror = () => {
                            db.close();
                            resolve({ error: 'tx failed' });
                        };
                    };
                    req.onerror = () => {
                        db.close();
                        resolve({ error: 'read albums failed' });
                    };
                };
                open.onerror = () => resolve({ error: 'open failed' });
            });
        },
        { n },
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

    const results = { startedAt: new Date().toISOString() };
    try {
        log('Phase 1: opt-in + hydrate');
        await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
        await clickEnableNow(page);
        await clickSyncNow(page);
        const sweep = await waitSweep(page, 60_000);
        results.hydrate = sweep;
        log('hydrate:', sweep);

        log('Phase 2: inject favorites into Dexie');
        const fav = await injectAlbumFavorites(page, 3);
        results.injectedFavorites = fav;
        log('favorites injected:', fav);
        await page.screenshot({ path: join(OUT, '01-after-inject.png') });

        log('Phase 3: drive favorite=true via URL param');
        // Reload to make sure the cache lifecycle reopens the DB after our
        // direct Dexie writes (the open handle could have gone stale).
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(3500);
        // Dump favorites table to confirm rows survived the reload
        const favRows = await page.evaluate(async () => {
            const dbs = await indexedDB.databases();
            const t = dbs.find((d) => (d.name || '').startsWith('feishin-cache:'));
            if (!t) return null;
            return new Promise((resolve) => {
                const open = indexedDB.open(t.name);
                open.onsuccess = () => {
                    const db = open.result;
                    if (!db.objectStoreNames.contains('favorites')) {
                        db.close();
                        resolve([]);
                        return;
                    }
                    const req = db
                        .transaction(['favorites'], 'readonly')
                        .objectStore('favorites')
                        .getAll();
                    req.onsuccess = () => {
                        const r = req.result;
                        db.close();
                        resolve(r);
                    };
                    req.onerror = () => {
                        db.close();
                        resolve([]);
                    };
                };
                open.onerror = () => resolve([]);
            });
        });
        results.favoritesTable = favRows;
        log('favorites table rows:', favRows?.length, favRows?.slice(0, 3));
        await page.goto(BASE + '/#/library/albums?favorite=true', {
            waitUntil: 'domcontentloaded',
        });
        await sleep(500);

        // Measure spinner duration + content visible
        const start = Date.now();
        const initialState = await page.evaluate(() => ({
            rows: document.querySelectorAll('.ag-row, [role="row"]').length,
            spinner: document.querySelectorAll('[class*="spinner" i], [data-loading="true"]')
                .length,
            text: ((document.querySelector('main') || document.body).textContent || '').slice(
                0,
                200,
            ),
        }));
        let resolvedMs = -1;
        try {
            await page.waitForFunction(
                () => {
                    const sp = document.querySelectorAll(
                        '[class*="spinner" i], [data-loading="true"]',
                    ).length;
                    const rows = document.querySelectorAll('.ag-row, [role="row"]').length;
                    return sp === 0 && rows >= 2;
                },
                { timeout: 8_000 },
            );
            resolvedMs = Date.now() - start;
        } catch {}
        await page.screenshot({ path: join(OUT, '03-after-filter.png') });
        results.measurements = {
            initialState,
            resolvedMs,
        };
        log('initial state at click:', initialState);
        log('resolved in', resolvedMs, 'ms');

        // Also count current ag-rows visible
        const finalRows = await page.evaluate(
            () => document.querySelectorAll('.ag-row, [role="row"]').length,
        );
        results.measurements.finalRows = finalRows;
        log('final rows:', finalRows);

        // Capture the cache logs around the filter activation
        const recentCacheLogs = consoleLog.filter((m) => /\[cache\]/.test(m.text)).slice(-40);
        results.recentCacheLogs = recentCacheLogs;
    } catch (err) {
        results.fatal = err.message + '\n' + err.stack;
        log('FATAL:', err.message);
    } finally {
        results.errors = consoleLog.filter((m) => m.type === 'error' || m.type === 'pageerror');
        writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
        await browser.close();
        log('done at', OUT);
    }
}

async function navigateAndOpenFilters(page) {
    await page.goto(BASE + '/#/library/albums', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    // Find the "Filters" button. The Jellyfin filter is opened by a
    // ChipButton labelled "Filters" or by an icon-only button.
    const candidates = ['button[aria-label*="filter" i]', 'button:has-text("Filter")'];
    for (const sel of candidates) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            await sleep(700);
            return true;
        }
    }
    return false;
}

async function setFavoriteSegmentToYes(page) {
    // The SegmentedControl renders as a group of <label> + <input type="radio">.
    // The segment values are 'true' / 'false' / undefined (All). We want 'true'.
    // Mantine 7 renders the segment label text from data.
    const labels = ['Yes', 'true', 'On', 'Favorited'];
    for (const label of labels) {
        const lab = page.locator(`label:has-text("${label}")`).first();
        if (await lab.isVisible().catch(() => false)) {
            await lab.click();
            return { label };
        }
    }
    // Fallback: click the radio with value="true" near the favorite text
    const favText = page.locator('text=/favorited/i').first();
    if (await favText.isVisible().catch(() => false)) {
        const segControl = favText.locator(
            'xpath=following::*[contains(@class, "SegmentedControl") or @role="radiogroup"][1]',
        );
        if (await segControl.isVisible().catch(() => false)) {
            const radios = segControl.locator('input[type="radio"]');
            const ct = await radios.count();
            log('segControl has', ct, 'radios');
            // Index 1 = Yes (assuming All=0, Yes=1, No=2)
            if (ct >= 2) {
                await radios.nth(1).check({ force: true });
                return { label: 'index1' };
            }
        }
    }
    return null;
}

async function waitSweep(page, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (sweepWatcher.completed) return { complete: true };
        if (sweepWatcher.lastEvent && Date.now() - sweepWatcher.lastEvent > 5000)
            return { complete: false, reason: 'quiet' };
        await sleep(500);
    }
    return { complete: false, reason: 'timeout' };
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
