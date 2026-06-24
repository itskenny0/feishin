import clsx from 'clsx';
import { ComponentPropsWithoutRef, CSSProperties, memo, useMemo } from 'react';

import styles from './lyric-line.module.css';

import { sanitize } from '/@/renderer/utils/sanitize';

interface LyricLineProps extends ComponentPropsWithoutRef<'div'> {
    alignment: 'center' | 'left' | 'right';
    fontSize: number;
    text: string;
}

// A flat flex-column <div> is behaviorally equivalent to the previous
// Mantine Box+Stack subtree (Box -> styled div, Stack -> flex column gap=0)
// but allocates far fewer React elements per line, so long lyric lists no
// longer hitch on open / track change.
const INNER_STYLE: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
};

export const LyricLine = memo(
    ({ alignment, className, fontSize, text, ...props }: LyricLineProps) => {
        const lines = useMemo(() => text.split('_BREAK_'), [text]);

        const style = useMemo(
            () => ({
                fontSize,
                textAlign: alignment,
            }),
            [fontSize, alignment],
        );

        return (
            <div className={clsx(styles.lyricLine, className)} style={style} {...props}>
                <div style={INNER_STYLE}>
                    {lines.map((line, index) => (
                        <span dangerouslySetInnerHTML={{ __html: sanitize(line) }} key={index} />
                    ))}
                </div>
            </div>
        );
    },
);

LyricLine.displayName = 'LyricLine';
