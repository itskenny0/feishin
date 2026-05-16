/**
 * Run an array of async jobs with bounded concurrency. Resolves with the
 * same order as the input, mirroring Promise.all's shape.
 *
 * Used by bulk admin operations (mark-played, refresh-metadata, …) so that
 * right-clicking 1000 items doesn't fire 1000 parallel HTTP requests at the
 * server (which most rate-limiters will reject or batch-fail).
 */
export const runWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
    if (items.length === 0) return [];
    const limit = Math.max(1, Math.floor(concurrency));
    const results = new Array<R>(items.length);
    let next = 0;
    const runOne = async (): Promise<void> => {
        while (true) {
            const idx = next++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
        }
    };
    const runners: Promise<void>[] = [];
    for (let i = 0; i < Math.min(limit, items.length); i += 1) {
        runners.push(runOne());
    }
    await Promise.all(runners);
    return results;
};
