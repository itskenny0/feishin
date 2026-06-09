// Regression tests for the web/Android updater's version comparison.
//
// The old implementation compared the whole normalized version as a string,
// so the MAJOR.MINOR.PATCH head was ordered lexicographically: '1.13.0' sorted
// BELOW '1.9.0' (because '1' < '9' at the third char). A genuinely newer
// release was reported as "not newer" and never offered — and an older one
// could be offered as an update. The fork is already past that digit boundary
// (1.9 → 1.10 → 1.11 → 1.13), so this was live.

import { describe, expect, it } from 'vitest';

import { isNewerVersion } from '/@/renderer/hooks/use-github-releases-updater';

const tag = (v: string) => `v${v}-itskenny0-2026.06.09-0026`;

describe('isNewerVersion', () => {
    it('orders multi-digit minor versions numerically (the regression)', () => {
        // 1.13.0 IS newer than 1.9.0 — the old string compare got this wrong.
        expect(isNewerVersion(tag('1.13.0'), tag('1.9.0'))).toBe(true);
        // ...and an older base must NOT be offered as an update.
        expect(isNewerVersion(tag('1.9.0'), tag('1.13.0'))).toBe(false);
    });

    it('orders multi-digit patch versions numerically', () => {
        expect(isNewerVersion(tag('1.13.10'), tag('1.13.2'))).toBe(true);
        expect(isNewerVersion(tag('1.13.2'), tag('1.13.10'))).toBe(false);
    });

    it('compares the dated fork suffix when the head is equal', () => {
        const older = 'v1.13.0-itskenny0-2026.06.08-2342';
        const newer = 'v1.13.0-itskenny0-2026.06.09-0026';
        expect(isNewerVersion(newer, older)).toBe(true);
        expect(isNewerVersion(older, newer)).toBe(false);
    });

    it('treats the git-tag (dotted) and package.json (dashed) forms as equal', () => {
        // CI rewrites suffix dots to dashes in package.json; the two forms of
        // the SAME release must not read as an update over each other.
        expect(
            isNewerVersion('v1.13.0-itskenny0-2026.06.09-0026', '1.13.0-itskenny0-2026-06-09-0026'),
        ).toBe(false);
    });

    it('returns false for identical versions', () => {
        expect(isNewerVersion(tag('1.13.0'), tag('1.13.0'))).toBe(false);
    });

    it('orders a major bump correctly', () => {
        expect(isNewerVersion(tag('2.0.0'), tag('1.99.99'))).toBe(true);
    });
});
