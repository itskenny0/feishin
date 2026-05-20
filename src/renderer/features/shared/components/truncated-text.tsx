import type { ComponentProps, CSSProperties, ReactNode, RefObject } from 'react';

import { useEffect, useRef, useState } from 'react';

import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';

export interface TruncatedTextProps extends Omit<TextProps, 'children'> {
    /**
     * Visible text. Rendered inside a Text component with the standard
     * `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
     * recipe. When the rendered text is actually clipped, hovering
     * shows the full string in a Tooltip; otherwise the tooltip stays
     * out of the way.
     */
    children: ReactNode;
    /** Extra style merged into the inner Text component. */
    style?: CSSProperties;
    /** Override the tooltip label when `children` isn't a plain string. */
    tooltipLabel?: ReactNode;
    /** Tooltip placement. Defaults to 'top'. */
    tooltipPosition?: 'bottom' | 'left' | 'right' | 'top';
}

type TextProps = ComponentProps<typeof Text>;

/**
 * Hook: detect whether the referenced element is overflowing
 * horizontally and would therefore be rendering an ellipsis.
 *
 * Compares scrollWidth vs clientWidth on a ResizeObserver. Returns a
 * ref to attach to the element and a boolean truncation flag. The
 * caller is responsible for the CSS that triggers the ellipsis itself
 * (overflow: hidden; text-overflow: ellipsis; white-space: nowrap).
 *
 * A 1px slack guards against subpixel rounding on Hi-DPI displays
 * where the two values can disagree by a fraction without an actual
 * ellipsis being drawn.
 */
export const useTruncationDetection = <T extends HTMLElement>(
    deps: readonly unknown[] = [],
): { isTruncated: boolean; ref: RefObject<null | T> } => {
    const ref = useRef<null | T>(null);
    const [isTruncated, setIsTruncated] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const check = () => {
            setIsTruncated(el.scrollWidth - el.clientWidth > 1);
        };

        check();

        const ro = new ResizeObserver(check);
        ro.observe(el);

        return () => {
            ro.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    return { isTruncated, ref };
};

/**
 * Wraps a Text component so that when its content is wider than the
 * available space and the CSS truncation kicks in, hovering shows a
 * tooltip with the full string. The tooltip is hidden when the text
 * fits, so it never fires for short strings.
 *
 * The detection element is a plain `<span>` wrapping the Text. This
 * keeps the ref on a concrete DOM node (the Text export is a
 * polymorphic component whose ref forwarding is murky) and gives the
 * tooltip a stable anchor.
 */
export const TruncatedText = ({
    children,
    style,
    tooltipLabel,
    tooltipPosition = 'top',
    ...textProps
}: TruncatedTextProps) => {
    const { isTruncated, ref } = useTruncationDetection<HTMLSpanElement>([children]);

    const inner = (
        <span
            ref={ref}
            style={{
                display: 'block',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                width: '100%',
            }}
        >
            <Text
                {...textProps}
                style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    ...style,
                }}
            >
                {children}
            </Text>
        </span>
    );

    const label = tooltipLabel ?? (typeof children === 'string' ? children : null);
    if (!isTruncated || label === null || label === '') return inner;

    return (
        <Tooltip label={label} openDelay={500} position={tooltipPosition} withinPortal>
            {inner}
        </Tooltip>
    );
};
