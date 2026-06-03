import { describe, expect, it } from 'vitest';

import { constrainRightSidebarWidth, constrainSidebarWidth } from './constrain-sidebar-width';
import { getHeaderColor } from './get-header-color';
import { getServerUrl, normalizeServerUrl } from './normalize-server-url';
import { rgbToRgba } from './rgb-to-rgba';
import { sentenceCase } from './sentence-case';
import { titleCase } from './title-case';
import { truncateMiddle } from './truncate-middle';

import { ServerListItem } from '/@/shared/types/domain-types';

describe('truncateMiddle', () => {
    it('returns the input unchanged when it is within the limit', () => {
        expect(truncateMiddle('short', 10)).toBe('short');
    });

    it('returns the input unchanged when it equals the limit', () => {
        expect(truncateMiddle('exactlyten', 10)).toBe('exactlyten');
    });

    it('inserts an ellipsis in the middle when over the limit', () => {
        const result = truncateMiddle('abcdefghijklmnop', 9);
        expect(result).toContain('…');
        expect(result.startsWith('abc')).toBe(true);
        expect(result.endsWith('nop')).toBe(true);
    });

    it('keeps balanced halves around the ellipsis', () => {
        // maxLength 11 -> halfLength = floor((11 - 1) / 2) = 5
        expect(truncateMiddle('0123456789ABCDEF', 11)).toBe('01234…BCDEF');
    });

    it('handles an empty string', () => {
        expect(truncateMiddle('', 5)).toBe('');
    });
});

describe('sentenceCase', () => {
    it('uppercases the first character only', () => {
        expect(sentenceCase('hello world')).toBe('Hello world');
    });

    it('leaves an already-capitalised string intact', () => {
        expect(sentenceCase('Hello')).toBe('Hello');
    });

    it('handles a single character', () => {
        expect(sentenceCase('a')).toBe('A');
    });

    it('handles an empty string', () => {
        expect(sentenceCase('')).toBe('');
    });
});

describe('titleCase', () => {
    it('capitalises the first letter of each word', () => {
        expect(titleCase('hello world')).toBe('Hello World');
    });

    it('lowercases the remaining characters of each word', () => {
        expect(titleCase('hELLO wORLD')).toBe('Hello World');
    });

    it('handles a single word', () => {
        expect(titleCase('rock')).toBe('Rock');
    });

    it('treats a hyphenated run as a single token (only whitespace splits words)', () => {
        // The /\w\S*/g matcher only breaks on whitespace, so a hyphenated run
        // is one token: first char uppercased, the remainder lowercased.
        expect(titleCase('rock-and-roll')).toBe('Rock-and-roll');
    });

    it('capitalises each space-separated word independently', () => {
        expect(titleCase('the rolling stones')).toBe('The Rolling Stones');
    });
});

describe('rgbToRgba', () => {
    it('returns undefined when no colour is provided', () => {
        expect(rgbToRgba(undefined, 0.5)).toBeUndefined();
    });

    it('converts an rgb string to rgba with the given alpha', () => {
        expect(rgbToRgba('rgb(10, 20, 30)', 0.5)).toBe('rgba(10, 20, 30, 0.5)');
    });

    it('supports a zero alpha', () => {
        expect(rgbToRgba('rgb(0, 0, 0)', 0)).toBe('rgba(0, 0, 0, 0)');
    });
});

describe('getHeaderColor', () => {
    it('defaults to 0.8 alpha when opacity is omitted', () => {
        expect(getHeaderColor('rgb(1, 2, 3)')).toBe('rgba(1, 2, 3, 0.8)');
    });

    it('uses the provided opacity', () => {
        expect(getHeaderColor('rgb(1, 2, 3)', 0.25)).toBe('rgba(1, 2, 3, 0.25)');
    });

    it('falls back to 0.8 when opacity is 0 (falsy)', () => {
        // `opacity || 0.8` treats 0 as falsy by design.
        expect(getHeaderColor('rgb(1, 2, 3)', 0)).toBe('rgba(1, 2, 3, 0.8)');
    });
});

describe('constrainSidebarWidth', () => {
    it('clamps to the lower bound', () => {
        expect(constrainSidebarWidth(100)).toBe(300);
    });

    it('clamps to the upper bound', () => {
        expect(constrainSidebarWidth(900)).toBe(400);
    });

    it('passes through values within range', () => {
        expect(constrainSidebarWidth(320)).toBe(320);
    });

    it('keeps the exact bounds', () => {
        expect(constrainSidebarWidth(300)).toBe(300);
        expect(constrainSidebarWidth(400)).toBe(400);
    });
});

describe('constrainRightSidebarWidth', () => {
    it('clamps to the lower bound', () => {
        expect(constrainRightSidebarWidth(100)).toBe(250);
    });

    it('clamps to the upper bound', () => {
        expect(constrainRightSidebarWidth(2000)).toBe(960);
    });

    it('passes through values within range', () => {
        expect(constrainRightSidebarWidth(500)).toBe(500);
    });
});

describe('normalizeServerUrl', () => {
    it('removes a single trailing slash', () => {
        expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com');
    });

    it('leaves a url without a trailing slash unchanged', () => {
        expect(normalizeServerUrl('https://example.com')).toBe('https://example.com');
    });
});

describe('getServerUrl', () => {
    const makeServer = (
        overrides: Partial<Record<keyof ServerListItem, unknown>>,
    ): ServerListItem =>
        ({
            id: 'srv',
            name: 'Server',
            preferRemoteUrl: false,
            remoteUrl: null,
            type: 'jellyfin',
            url: 'https://local.example.com',
            ...overrides,
        }) as unknown as ServerListItem;

    it('returns undefined when there is no server', () => {
        expect(getServerUrl(null)).toBeUndefined();
        expect(getServerUrl(undefined)).toBeUndefined();
    });

    it('returns the local url when remote is not preferred', () => {
        expect(getServerUrl(makeServer({}))).toBe('https://local.example.com');
    });

    it('returns the remote url when preferRemoteUrl is set and a remote exists', () => {
        const server = makeServer({
            preferRemoteUrl: true,
            remoteUrl: 'https://remote.example.com',
        });
        expect(getServerUrl(server)).toBe('https://remote.example.com');
    });

    it('falls back to the local url when remote is preferred but missing', () => {
        const server = makeServer({ preferRemoteUrl: true, remoteUrl: null });
        expect(getServerUrl(server)).toBe('https://local.example.com');
    });

    it('forces the remote url when forceRemoteUrl is true', () => {
        const server = makeServer({
            preferRemoteUrl: false,
            remoteUrl: 'https://remote.example.com',
        });
        expect(getServerUrl(server, true)).toBe('https://remote.example.com');
    });
});
