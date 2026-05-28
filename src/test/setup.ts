import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom doesn't implement IndexedDB, which `idb-keyval` (used by the persisted
// zustand stores' autosave) requires. Importing any module that transitively
// pulls in those stores would otherwise raise an unhandled rejection and fail
// the whole run. Back it with an in-memory map so persistence is a harmless
// no-op in tests.
vi.mock('idb-keyval', () => {
    const store = new Map<IDBValidKey, unknown>();
    return {
        clear: async () => store.clear(),
        createStore: () => ({}),
        del: async (key: IDBValidKey) => void store.delete(key),
        delMany: async (keys: IDBValidKey[]) => keys.forEach((k) => store.delete(k)),
        entries: async () => [...store.entries()],
        get: async (key: IDBValidKey) => store.get(key),
        getMany: async (keys: IDBValidKey[]) => keys.map((k) => store.get(k)),
        keys: async () => [...store.keys()],
        set: async (key: IDBValidKey, value: unknown) => void store.set(key, value),
        setMany: async (entries: [IDBValidKey, unknown][]) =>
            entries.forEach(([k, v]) => store.set(k, v)),
        update: async (key: IDBValidKey, updater: (old: unknown) => unknown) =>
            void store.set(key, updater(store.get(key))),
        values: async () => [...store.values()],
    };
});

// A handful of test files run in the `node` environment (e.g. main-process
// broker smoke tests) and have no `window`. Skip the jsdom polyfills below
// when running in that mode — they exist purely to shore up jsdom gaps.
const hasWindow =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined';

// jsdom doesn't implement PointerEvent. useLongPress reads `pointerType`,
// `clientX`, and `clientY` off the event, so provide a minimal shim built on
// MouseEvent (which already carries clientX/clientY).
if (hasWindow && typeof window.PointerEvent === 'undefined') {
    class PointerEventShim extends MouseEvent {
        pointerType: string;

        constructor(type: string, params: PointerEventInit = {}) {
            super(type, params);
            this.pointerType = (params as { pointerType?: string }).pointerType ?? 'mouse';
        }
    }
    // @ts-expect-error — assigning the shim onto window
    window.PointerEvent = PointerEventShim;
}

// Mantine floating-ui (Popover/Tooltip positioning) needs ResizeObserver,
// which jsdom doesn't implement.
if (hasWindow && typeof window.ResizeObserver === 'undefined') {
    const noop = (): void => undefined;
    // @ts-expect-error — minimal stub
    window.ResizeObserver = class {
        disconnect = noop;
        observe = noop;
        unobserve = noop;
    };
}

// Some imported modules touch matchMedia at construction time.
if (hasWindow && typeof window.matchMedia === 'undefined') {
    // @ts-expect-error — minimal stub
    window.matchMedia = (query: string) => ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
    });
}
