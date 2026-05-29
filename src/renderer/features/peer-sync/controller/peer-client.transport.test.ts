/**
 * Transport resolution across platforms.
 *
 * `resolveEffectiveTransport` decides WebSocket vs raw-TCP from the user
 * preference, the broker URL scheme, and an injectable runtime env. Raw TCP is
 * reachable on Android (Capacitor TcpSocket plugin) OR Electron desktop (the
 * main-process IPC bridge); the browser/PWA has no raw-socket API and must
 * always fall back to WebSocket.
 */
import { describe, expect, it } from 'vitest';

import {
    parseTcpTarget,
    resolveEffectiveTransport,
    type TransportEnv,
} from '/@/renderer/features/peer-sync/controller/peer-client';

const env = (over: Partial<TransportEnv>): TransportEnv => ({
    android: false,
    bridgeAvailable: false,
    electron: false,
    pluginAvailable: false,
    ...over,
});

const WEB = env({});
const ANDROID_WITH_PLUGIN = env({ android: true, pluginAvailable: true });
const ANDROID_NO_PLUGIN = env({ android: true, pluginAvailable: false });
const ELECTRON_WITH_BRIDGE = env({ bridgeAvailable: true, electron: true });
const ELECTRON_NO_BRIDGE = env({ bridgeAvailable: false, electron: true });

describe('resolveEffectiveTransport', () => {
    it("forces ws when the user picks 'ws' regardless of platform", () => {
        expect(resolveEffectiveTransport('ws', 'mqtt://broker:1883', ANDROID_WITH_PLUGIN)).toBe(
            'ws',
        );
        expect(resolveEffectiveTransport('ws', 'mqtt://broker:1883', ELECTRON_WITH_BRIDGE)).toBe(
            'ws',
        );
    });

    it("resolves 'tcp' on Electron with the IPC bridge present", () => {
        expect(resolveEffectiveTransport('tcp', 'mqtt://broker:1883', ELECTRON_WITH_BRIDGE)).toBe(
            'tcp',
        );
        // auto + mqtt scheme also upgrades.
        expect(resolveEffectiveTransport('auto', 'mqtt://broker:1883', ELECTRON_WITH_BRIDGE)).toBe(
            'tcp',
        );
    });

    it("resolves 'tcp' on Android with the Capacitor plugin present", () => {
        expect(resolveEffectiveTransport('tcp', 'mqtt://broker:1883', ANDROID_WITH_PLUGIN)).toBe(
            'tcp',
        );
    });

    it('falls back to ws on Android when the plugin is unavailable', () => {
        expect(resolveEffectiveTransport('tcp', 'mqtt://broker:1883', ANDROID_NO_PLUGIN)).toBe(
            'ws',
        );
    });

    it('falls back to ws on Electron when the bridge is unavailable', () => {
        expect(resolveEffectiveTransport('tcp', 'mqtt://broker:1883', ELECTRON_NO_BRIDGE)).toBe(
            'ws',
        );
    });

    it('falls back to ws in the browser/PWA even when tcp is requested', () => {
        expect(resolveEffectiveTransport('tcp', 'mqtt://broker:1883', WEB)).toBe('ws');
        expect(resolveEffectiveTransport('auto', 'mqtt://broker:1883', WEB)).toBe('ws');
    });

    it('auto stays ws for ws/bare URLs even where tcp is available', () => {
        expect(resolveEffectiveTransport('auto', 'ws://broker:8083', ELECTRON_WITH_BRIDGE)).toBe(
            'ws',
        );
        expect(resolveEffectiveTransport('auto', 'broker.lan', ANDROID_WITH_PLUGIN)).toBe('ws');
    });
});

describe('parseTcpTarget', () => {
    it('parses bare host with default raw-MQTT port 1883', () => {
        expect(parseTcpTarget('broker.lan')).toEqual({
            host: 'broker.lan',
            port: 1883,
            tls: false,
        });
    });

    it('parses an explicit mqtt:// host:port', () => {
        expect(parseTcpTarget('mqtt://broker.lan:1884')).toEqual({
            host: 'broker.lan',
            port: 1884,
            tls: false,
        });
    });

    it('parses mqtts:// as TLS with default 8883', () => {
        expect(parseTcpTarget('mqtts://secure.lan')).toEqual({
            host: 'secure.lan',
            port: 8883,
            tls: true,
        });
    });

    // S1-A: a ws:// URL points at the WebSocket listener (HTTP Upgrade), NOT a
    // raw-MQTT port. Carrying its port (e.g. 8083) into a raw socket either gets
    // reset → 4s reconnect storm, or hangs until connectTimeout. We must re-map
    // to the standard raw-MQTT port and DROP the WS port.
    it('re-maps ws://host:8083 to raw mqtt:1883 (drops the WS port) — S1-A', () => {
        expect(parseTcpTarget('ws://broker.lan:8083')).toEqual({
            host: 'broker.lan',
            port: 1883,
            tls: false,
        });
    });

    it('re-maps wss://host:8084 to raw mqtts:8883 (drops the WS port) — S1-A', () => {
        expect(parseTcpTarget('wss://broker.lan:8084')).toEqual({
            host: 'broker.lan',
            port: 8883,
            tls: true,
        });
    });

    it('re-maps a ws:// URL without an explicit port too', () => {
        expect(parseTcpTarget('ws://broker.lan')).toEqual({
            host: 'broker.lan',
            port: 1883,
            tls: false,
        });
    });

    it('returns null for empty input', () => {
        expect(parseTcpTarget('')).toBeNull();
        expect(parseTcpTarget('   ')).toBeNull();
    });
});
