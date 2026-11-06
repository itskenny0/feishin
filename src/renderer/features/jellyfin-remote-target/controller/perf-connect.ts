/**
 * Opt-in Connect latency tracing shared by the dispatch, publish and mirror
 * paths of both lanes. Enable with localStorage['perf.connect'] = '1'; free
 * (a single storage read) otherwise.
 */
export const perfConnect = (label: string, payload: Record<string, unknown>): void => {
    try {
        if (localStorage.getItem('perf.connect') !== '1') return;
    } catch {
        return;
    }
    console.info('[perf.connect]', label, { ts: performance.now(), ...payload });
};
