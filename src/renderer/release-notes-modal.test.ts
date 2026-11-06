import { describe, expect, it } from 'vitest';

import { GitHubRelease } from '/@/renderer/hooks/use-github-releases';
import { resolveReleaseVersion } from '/@/renderer/release-notes-modal';

const release = (tag_name: string) => ({ tag_name }) as GitHubRelease;

describe('resolveReleaseVersion', () => {
    const releases = [
        release('v1.17.0-itskenny0-2026.11.06-0215'),
        release('v1.17.0-itskenny0-2026.11.05-2210'),
    ];

    it('maps a release build version (dots stamped as dashes) to its tag version', () => {
        expect(resolveReleaseVersion('1.17.0-itskenny0-2026-11-06-0215', releases)).toBe(
            '1.17.0-itskenny0-2026.11.06-0215',
        );
    });

    it('keeps the version when no release matches', () => {
        expect(resolveReleaseVersion('1.17.0', releases)).toBe('1.17.0');
        expect(resolveReleaseVersion('1.17.0', [])).toBe('1.17.0');
    });
});
