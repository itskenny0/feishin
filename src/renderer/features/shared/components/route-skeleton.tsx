import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Stack } from '/@/shared/components/stack/stack';

/**
 * Generic route-level loading fallback. Replaces <Spinner container /> in
 * Suspense fallbacks for lazy-loaded routes. Renders a content-shaped
 * skeleton (header strip + a few body rows) rather than a centered
 * spinner, so the layout doesn't visibly snap when the route hydrates.
 *
 * Tuned to be unobtrusive — uses the existing Skeleton component's
 * animation. The actual content of the route just replaces these
 * placeholders on render, with no further layout shift.
 */
export const RouteSkeleton = () => {
    return (
        <Stack gap="md" p="lg">
            <Skeleton enableAnimation height={36} width="40%" />
            <Skeleton enableAnimation height={20} width="60%" />
            <Stack gap="xs" mt="md">
                {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton enableAnimation height={40} key={i} />
                ))}
            </Stack>
        </Stack>
    );
};
