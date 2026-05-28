/**
 * Public-broker heuristic — drives the inline warning callout in the
 * Peer sync settings UI. Public hosts must trigger the alert; RFC1918,
 * loopback, link-local and .local must not.
 */
import { describe, expect, it } from 'vitest';

import { isPublicBrokerUrl } from '/@/renderer/features/settings/components/window/peer-sync-settings';

describe('isPublicBrokerUrl', () => {
    it('treats localhost and loopback as private', () => {
        expect(isPublicBrokerUrl('ws://localhost:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://127.0.0.1:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://[::1]:8083')).toBe(false);
    });

    it('treats RFC1918 ranges as private', () => {
        expect(isPublicBrokerUrl('ws://10.0.0.5:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://192.168.1.10:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://172.16.0.1:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://172.31.255.255:8083')).toBe(false);
    });

    it('treats link-local and .local as private', () => {
        expect(isPublicBrokerUrl('ws://my-mac.local:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://169.254.1.1:8083')).toBe(false);
    });

    it('treats Tailscale CGNAT (100.64.0.0/10) as private', () => {
        expect(isPublicBrokerUrl('ws://100.64.0.5:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://100.100.1.1:8083')).toBe(false);
        expect(isPublicBrokerUrl('ws://100.127.255.255:8083')).toBe(false);
    });

    it('flags a public hostname as needing the warning', () => {
        expect(isPublicBrokerUrl('wss://broker.hivemq.com:8884/mqtt')).toBe(true);
        expect(isPublicBrokerUrl('ws://test.mosquitto.org:8080')).toBe(true);
        expect(isPublicBrokerUrl('ws://203.0.113.5:8083')).toBe(true);
    });

    it('returns false for an empty / unparseable input', () => {
        expect(isPublicBrokerUrl('')).toBe(false);
        expect(isPublicBrokerUrl('not a url')).toBe(false);
    });
});
