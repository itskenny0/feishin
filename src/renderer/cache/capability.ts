// Runtime detection for whether the local-first cache can operate on this
// platform. IndexedDB is unavailable in Safari Private mode and in some
// hardened Android WebViews. We probe once at startup and stash the result.

let cached: boolean | undefined;

const probeIdb = async (): Promise<boolean> => {
    if (typeof indexedDB === 'undefined') return false;
    try {
        const probe = indexedDB.open('feishin-cache-probe', 1);
        return await new Promise<boolean>((resolve) => {
            probe.onerror = () => resolve(false);
            probe.onsuccess = () => {
                try {
                    probe.result.close();
                    indexedDB.deleteDatabase('feishin-cache-probe');
                } catch {
                    // best effort — even if delete fails, open worked
                }
                resolve(true);
            };
            // Some Android WebViews resolve onsuccess but throw on the next
            // op. Catch failures during the upgrade phase too.
            probe.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                try {
                    db.createObjectStore('probe');
                } catch {
                    resolve(false);
                }
            };
        });
    } catch {
        return false;
    }
};

export const isCacheAvailable = async (): Promise<boolean> => {
    if (cached !== undefined) return cached;
    cached = await probeIdb();
    return cached;
};

// Synchronous accessor for hooks that have already awaited the probe. If
// the probe hasn't resolved yet, returns false (cache-disabled is the safe
// default — callers must defensively fall back to vanilla react-query).
export const isCacheAvailableSync = (): boolean => cached === true;
