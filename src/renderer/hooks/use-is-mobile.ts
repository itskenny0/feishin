import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';

/**
 * @deprecated Prefer `useBreakpoint` / `useIsMobileShell` from
 * `/@/renderer/hooks/use-breakpoint` for clearer intent. Kept as an alias so
 * the existing call sites (responsive-layout, playerbar, full-screen-visualizer)
 * keep working — semantics are identical (< 768px).
 */
export const useIsMobile = () => useIsMobileShell();
