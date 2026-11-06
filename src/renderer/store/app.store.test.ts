import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadStore = async () => {
    vi.resetModules();
    const module = await import('/@/renderer/store/app.store');
    return module.useAppStore;
};

describe('app store persistence', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    // The command palette is a transient overlay: persisting `opened: true`
    // relaunched the app with the palette open (and, via use-hotkeys, every
    // global hotkey disabled until it was closed).
    it('does not persist or restore the open command palette', async () => {
        const store = await loadStore();
        store.getState().commandPalette.open();

        const persisted = JSON.parse(localStorage.getItem('store_app')!);
        expect(persisted.state.commandPalette).toBeUndefined();

        const relaunched = await loadStore();
        expect(relaunched.getState().commandPalette.opened).toBe(false);
    });

    it('ignores an open command palette in an older persisted blob', async () => {
        localStorage.setItem(
            'store_app',
            JSON.stringify({
                state: { commandPalette: { opened: true }, privateMode: true },
                version: 5,
            }),
        );

        const store = await loadStore();
        expect(store.getState().commandPalette.opened).toBe(false);
        // The rest of the blob still restores, and the palette stays usable.
        expect(store.getState().privateMode).toBe(true);
        store.getState().commandPalette.toggle();
        expect(store.getState().commandPalette.opened).toBe(true);
    });
});
