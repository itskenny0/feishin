// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const { handlers, signals } = vi.hoisted(() => ({
    handlers: new Map<string, Handler>(),
    signals: [] as AbortSignal[],
}));

vi.mock('electron', () => ({
    ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}));

// Each read stays in flight until its signal aborts.
vi.mock('./taglib-service', () => ({
    readFilesMetadataBatch: (_paths: string[], _onProgress: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve({ failedFiles: [], success: false })),
        );
    },
    readLocalImageFile: vi.fn(),
    writeFilesTags: vi.fn(),
}));

await import('./index');

describe('read-song-metadata-batch', () => {
    it('keeps a newer read cancellable after the read it superseded settles', async () => {
        const read = handlers.get('read-song-metadata-batch')!;
        const event = { sender: { send: () => {} } };

        const first = read(event, ['a.flac']);
        void read(event, ['b.flac']);
        await first; // aborted by the second read

        await handlers.get('cancel-read-song-metadata')!();

        expect(signals[1].aborted).toBe(true);
    });
});
