import { describe, expect, it } from 'vitest';

import { normalizeBrokerUrl } from '/@/renderer/features/peer-sync/controller/peer-client';

describe('normalizeBrokerUrl', () => {
    it('passes ws:// URLs through unchanged', () => {
        expect(normalizeBrokerUrl('ws://broker.example.com:8083')).toBe(
            'ws://broker.example.com:8083',
        );
    });

    it('passes wss:// URLs through unchanged', () => {
        expect(normalizeBrokerUrl('wss://broker.example.com:8084/mqtt')).toBe(
            'wss://broker.example.com:8084/mqtt',
        );
    });

    it('passes mqtt:// and mqtts:// URLs through unchanged', () => {
        expect(normalizeBrokerUrl('mqtt://broker.example.com')).toBe('mqtt://broker.example.com');
        expect(normalizeBrokerUrl('mqtts://broker.example.com:8883')).toBe(
            'mqtts://broker.example.com:8883',
        );
    });

    it('prepends ws:// to a bare LAN IP', () => {
        expect(normalizeBrokerUrl('192.168.1.5')).toBe('ws://192.168.1.5:8083');
    });

    it('prepends ws:// to a bare IP:port', () => {
        expect(normalizeBrokerUrl('192.168.1.5:8083')).toBe('ws://192.168.1.5:8083');
    });

    it('prepends ws:// to a bare hostname:port', () => {
        expect(normalizeBrokerUrl('broker.local:1883')).toBe('ws://broker.local:1883');
    });

    it('prepends ws://...:8083 to a bare hostname with no port', () => {
        expect(normalizeBrokerUrl('broker.local')).toBe('ws://broker.local:8083');
    });

    it('preserves a path on a bare host:port input', () => {
        expect(normalizeBrokerUrl('broker.local:8083/mqtt')).toBe('ws://broker.local:8083/mqtt');
    });

    it('handles empty input as empty (caller decides whether to start)', () => {
        expect(normalizeBrokerUrl('')).toBe('');
        expect(normalizeBrokerUrl('   ')).toBe('');
    });

    it('case-insensitive on scheme detection', () => {
        expect(normalizeBrokerUrl('WSS://broker.example.com:8084')).toBe(
            'WSS://broker.example.com:8084',
        );
    });
});
