import { Fragment, type ReactNode } from 'react';

import styles from './highlighted-text.module.css';

export interface HighlightedTextProps {
    /** Whether matching is case-sensitive. Default: false. */
    caseSensitive?: boolean;
    /** The substring to mark. If empty / falsy, the text is returned as-is. */
    query?: null | string;
    /** The text to render with optional highlighting. */
    text: null | string | undefined;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Renders `text` with every occurrence of `query` wrapped in a `<mark>`.
 * Used in search-result rows to draw the user's eye to the matched term.
 *
 * Returns `text` as a plain string when `query` is empty.
 *
 * NB: this matches a literal substring, not a tokenised search. If the
 * project's search uses fuzzy / weighted matching, the highlight here
 * may not exactly mirror what the backend matched on; that's accepted.
 */
export const HighlightedText = ({
    caseSensitive = false,
    query,
    text,
}: HighlightedTextProps): ReactNode => {
    if (!text) return text ?? '';
    if (!query || !query.trim()) return text;

    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(`(${escapeRegex(query.trim())})`, flags);
    const parts = text.split(pattern);

    return (
        <>
            {parts.map((part, i) => {
                if (!part) return null;
                // Pattern's capturing group means matched parts are at odd
                // indices.
                if (i % 2 === 1) {
                    return (
                        <mark className={styles.mark} key={`m-${i}`}>
                            {part}
                        </mark>
                    );
                }
                return <Fragment key={`t-${i}`}>{part}</Fragment>;
            })}
        </>
    );
};
