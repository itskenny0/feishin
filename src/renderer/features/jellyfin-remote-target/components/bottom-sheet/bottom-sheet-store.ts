import { create } from 'zustand';

/**
 * Tiny LIFO registry of dismiss callbacks for any open bottom-sheet
 * surface — currently just the mobile "Connect to a device" sheet, but
 * shaped as a stack so future sheets (e.g. queue / context menu) can
 * register too.
 *
 * The Android back gesture handler in `use-android-native.ts` reads
 * this stack BEFORE walking the router history. The previous build of
 * the device picker used a Mantine Drawer and relied on the back
 * handler's synthetic Escape dispatch closing it, but Mantine's drawer
 * close isn't synchronous so the handler fell through to
 * `window.history.back()` — and that pop was treated as "leave the
 * app" by the Capacitor WebView, matching the "Android back gesture
 * crashes the app" symptom in the user report.
 *
 * Lifecycle logging is tagged `[bottom-sheet]` per project convention.
 */

interface BottomSheetActions {
    /** Returns true if a dismiss was consumed. */
    dismissTop: () => boolean;
    push: (id: string, dismiss: () => void) => void;
    remove: (id: string) => void;
}

interface BottomSheetEntry {
    dismiss: () => void;
    id: string;
}

interface BottomSheetState {
    /** Dismiss callbacks pushed in mount order; top of stack is the most recent. */
    dismissStack: BottomSheetEntry[];
}

export const useBottomSheetStore = create<BottomSheetActions & BottomSheetState>((set, get) => ({
    dismissStack: [],
    dismissTop: () => {
        const stack = get().dismissStack;
        if (stack.length === 0) return false;
        const top = stack[stack.length - 1];
        console.info('[bottom-sheet] consuming back gesture for', top.id);
        try {
            top.dismiss();
        } catch (error) {
            console.warn('[bottom-sheet] dismiss callback threw:', error);
        }
        return true;
    },
    push: (id, dismiss) => {
        console.info('[bottom-sheet] mount', id);
        set((state) => ({
            dismissStack: [
                ...state.dismissStack.filter((entry) => entry.id !== id),
                { dismiss, id },
            ],
        }));
    },
    remove: (id) => {
        console.info('[bottom-sheet] unmount', id);
        set((state) => ({
            dismissStack: state.dismissStack.filter((entry) => entry.id !== id),
        }));
    },
}));
