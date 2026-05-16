/**
 * Heuristic gatekeeper for genre names worth surfacing on the home page.
 *
 * Jellyfin/Subsonic store user-tagged genre strings as flat rows; libraries
 * with sloppy tagging leak multi-tag concatenations ("rap;50 Cent;Gangsta…")
 * into the genre list. We drop names that look like junk so they don't
 * occupy real estate on the home page.
 *
 * Filters applied (any one disqualifies the name):
 *  - empty / whitespace
 *  - contains semicolons (multi-tag concatenation)
 *  - contains colons ("Category: Subcategory" multi-tag pattern)
 *  - excessive commas (4+ — composite list)
 *  - 3+ consecutive digits AND not a recognised decade label like "90s",
 *    "2000s", "2010s" (the previous version rejected those too)
 *  - longer than 40 characters
 *  - majority non-letter characters
 */
const DECADE_NAME_RE = /^\d{2,4}s$/;

export const isCleanGenreName = (name: string): boolean => {
    if (!name) return false;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 40) return false;
    if (trimmed.includes(';')) return false;
    if (trimmed.includes(':')) return false;
    if ((trimmed.match(/,/g) || []).length >= 4) return false;

    // Reject 3+ consecutive digits UNLESS the whole name is a decade label.
    // "90s" / "2000s" / "2010s" are legitimate genre tags many libraries use.
    if (/\d{3,}/.test(trimmed) && !DECADE_NAME_RE.test(trimmed)) return false;

    // Letters should make up at least half the string — protects against
    // pure-numeric or symbol-heavy junk like "808" or "/// dark". The decade
    // exception above bypasses this rule.
    if (DECADE_NAME_RE.test(trimmed)) return true;
    const letterCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
    return letterCount * 2 >= trimmed.length;
};
