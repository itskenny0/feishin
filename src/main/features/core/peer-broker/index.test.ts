// @vitest-environment node
import type { AddressInfo } from 'net';

import { Aedes } from 'aedes';
import { createServer } from 'http';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }));

import { isPeerBrokerRunning, startPeerBroker } from './index';

describe('startPeerBroker', () => {
    it('closes the broker it created when the port is already in use', async () => {
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const { port } = blocker.address() as AddressInfo;

        const createBroker = vi.spyOn(Aedes, 'createBroker');
        try {
            await expect(
                startPeerBroker({ host: '127.0.0.1', port, roomKey: 'room' }),
            ).rejects.toMatchObject({ code: 'EADDRINUSE' });

            // aedes keeps heartbeat intervals alive until close(); a leaked
            // instance per failed enable would never be reclaimed.
            const aedes = await createBroker.mock.results[0].value;
            expect(aedes.closed).toBe(true);
            expect(isPeerBrokerRunning()).toBe(false);
        } finally {
            createBroker.mockRestore();
            await new Promise((resolve) => blocker.close(resolve));
        }
    });
});
