// Remote log shipper behaviour:
//  - console.error and uncaught errors ship IMMEDIATELY (crash evidence must
//    leave the device before the process dies);
//  - ordinary logs batch on the flush interval;
//  - heartbeats carry increasing seq numbers;
//  - disabling restores console and stops all traffic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    __resetRemoteLogShipperForTests,
    initRemoteLogShipper,
    normalizeEndpoint,
} from '/@/renderer/debug/remote-log-shipper';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const fetchMock = vi.fn().mockResolvedValue({ ok: true });

const setRemoteDebug = (enabled: boolean, endpoint = '192.168.1.5') => {
    useSettingsStore.setState((s) => ({ ...s, remoteDebug: { enabled, endpoint } }));
};

const shippedBodies = () => fetchMock.mock.calls.map((c) => String(c[1]?.body ?? ''));

beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    __resetRemoteLogShipperForTests();
    setRemoteDebug(false, '');
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('normalizeEndpoint', () => {
    it('defaults the port for a bare host', () => {
        expect(normalizeEndpoint('192.168.1.5')).toBe('http://192.168.1.5:19191/log');
    });

    it('respects an explicit port', () => {
        expect(normalizeEndpoint('myhost:9000')).toBe('http://myhost:9000/log');
    });

    it('passes through full URLs', () => {
        expect(normalizeEndpoint('http://10.0.0.2:8080')).toBe('http://10.0.0.2:8080/log');
    });

    it('rejects junk', () => {
        expect(normalizeEndpoint('')).toBeNull();
        expect(normalizeEndpoint('not a host!')).toBeNull();
    });
});

describe('remote log shipper', () => {
    it('does nothing while disabled', () => {
        setRemoteDebug(false, '');
        initRemoteLogShipper();
        console.info('hello');
        vi.advanceTimersByTime(2000);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ships console.error immediately, batches info on the flush tick', () => {
        setRemoteDebug(false, '');
        initRemoteLogShipper();
        setRemoteDebug(true);

        fetchMock.mockClear(); // drop the boot entry

        console.info('a quiet line');
        expect(shippedBodies().join('\n')).not.toContain('a quiet line');

        console.error('LOUD FAILURE');
        expect(shippedBodies().join('\n')).toContain('LOUD FAILURE');

        vi.advanceTimersByTime(350);
        expect(shippedBodies().join('\n')).toContain('a quiet line');
    });

    it('heartbeats with increasing seq', () => {
        setRemoteDebug(false, '');
        initRemoteLogShipper();
        setRemoteDebug(true);
        fetchMock.mockClear();

        vi.advanceTimersByTime(1100);
        const heartbeats = shippedBodies()
            .flatMap((b) => b.split('\n'))
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter((e) => e?.type === 'hb');
        expect(heartbeats.length).toBeGreaterThanOrEqual(2);
        expect(heartbeats[1].seq).toBe(heartbeats[0].seq + 1);
    });

    it('disabling restores console and stops traffic', () => {
        setRemoteDebug(false, '');
        initRemoteLogShipper();
        setRemoteDebug(true);
        setRemoteDebug(false);
        fetchMock.mockClear();

        console.error('after disable');
        vi.advanceTimersByTime(2000);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
