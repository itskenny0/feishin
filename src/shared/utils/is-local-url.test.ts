import { describe, expect, it } from 'vitest';

import { isLocalUrl } from '/@/shared/utils/is-local-url';

describe('isLocalUrl', () => {
    it.each([
        'http://localhost:4533',
        'http://127.0.0.1',
        'http://[::1]:8096',
        'http://192.168.1.20:8096',
        'http://10.0.0.5',
        'http://172.20.0.2',
        'http://nas.local',
        'http://[fd12:3456::1]:8096',
        'http://[fe80::1]',
    ])('treats %s as local', (url) => {
        expect(isLocalUrl(url)).toBe(true);
    });

    // The IPv6 unique-local / link-local prefix checks used to run against
    // every hostname, so public domains starting with fc/fd/fe8-feb were
    // reported as LAN addresses.
    it.each([
        'https://fdroid.example.com',
        'https://fcserver.example.org',
        'https://febreze.example.net',
        'https://music.example.com',
        'http://8.8.8.8',
        'not a url',
    ])('treats %s as not local', (url) => {
        expect(isLocalUrl(url)).toBe(false);
    });
});
