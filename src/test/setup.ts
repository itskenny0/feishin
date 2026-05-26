import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement PointerEvent. useLongPress reads `pointerType`,
// `clientX`, and `clientY` off the event, so provide a minimal shim built on
// MouseEvent (which already carries clientX/clientY).
if (typeof window.PointerEvent === 'undefined') {
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
if (typeof window.ResizeObserver === 'undefined') {
    const noop = (): void => undefined;
    // @ts-expect-error — minimal stub
    window.ResizeObserver = class {
        disconnect = noop;
        observe = noop;
        unobserve = noop;
    };
}

// Some imported modules touch matchMedia at construction time.
if (typeof window.matchMedia === 'undefined') {
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
