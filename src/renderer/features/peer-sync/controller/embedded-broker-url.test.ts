import { describe, expect, it } from 'vitest';

import { resolveEmbeddedBrokerUrl } from './embedded-broker-url';

describe('resolveEmbeddedBrokerUrl', () => {
    it('maps the 0.0.0.0 wildcard host to loopback', () => {
        expect(resolveEmbeddedBrokerUrl({ host: '0.0.0.0', port: 8083 })).toBe(
            'ws://127.0.0.1:8083',
        );
    });

    it('maps the :: IPv6 wildcard host to loopback', () => {
        expect(resolveEmbeddedBrokerUrl({ host: '::', port: 8083 })).toBe('ws://127.0.0.1:8083');
    });

    it('maps an empty host to loopback', () => {
        expect(resolveEmbeddedBrokerUrl({ host: '', port: 8083 })).toBe('ws://127.0.0.1:8083');
    });

    it('passes through a real LAN IP and port', () => {
        expect(resolveEmbeddedBrokerUrl({ host: '192.168.1.5', port: 9001 })).toBe(
            'ws://192.168.1.5:9001',
        );
    });

    it('defaults a missing/zero port to 8083', () => {
        expect(resolveEmbeddedBrokerUrl({ host: '0.0.0.0' })).toBe('ws://127.0.0.1:8083');
        expect(resolveEmbeddedBrokerUrl({ host: '0.0.0.0', port: 0 })).toBe('ws://127.0.0.1:8083');
    });

    it('uses wss when both TLS cert and key are present', () => {
        expect(
            resolveEmbeddedBrokerUrl({
                host: '0.0.0.0',
                port: 8084,
                tlsCertPath: '/c.pem',
                tlsKeyPath: '/k.pem',
            }),
        ).toBe('wss://127.0.0.1:8084');
    });

    it('stays on ws when only one TLS path is set', () => {
        expect(
            resolveEmbeddedBrokerUrl({ host: '0.0.0.0', port: 8083, tlsCertPath: '/c.pem' }),
        ).toBe('ws://127.0.0.1:8083');
    });

    it('brackets a bare IPv6 literal host', () => {
        expect(resolveEmbeddedBrokerUrl({ host: 'fe80::1', port: 8083 })).toBe(
            'ws://[fe80::1]:8083',
        );
    });

    it('returns null when no config is available', () => {
        expect(resolveEmbeddedBrokerUrl(null)).toBeNull();
        expect(resolveEmbeddedBrokerUrl(undefined)).toBeNull();
    });
});
