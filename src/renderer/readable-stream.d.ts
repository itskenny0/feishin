// The peer-sync native-TCP transport (src/renderer/features/peer-sync/transport/
// native-tcp-stream.ts) builds an mqtt.js custom stream by extending the Duplex
// from 'readable-stream' — mqtt.js's own bundled stream implementation. pnpm
// nests that copy under mqtt's scope, so the bundler aliases the bare specifier
// to it (see web.vite.config.ts / vitest.config.ts). tsc does not honour bundler
// aliases and the renderer tsconfig does not surface Node's 'stream' module, so
// declare the minimal Duplex surface the transport relies on here. This is a
// TYPES-ONLY shim; the real Duplex (with full Node stream semantics) is supplied
// at runtime by the bundler alias to mqtt's bundled readable-stream.
declare module 'readable-stream' {
    interface DuplexOptions {
        [key: string]: unknown;
        allowHalfOpen?: boolean;
        objectMode?: boolean;
    }

    export class Duplex {
        constructor(opts?: DuplexOptions);
        destroy(error?: Error): this;
        emit(event: string, ...args: unknown[]): boolean;
        end(cb?: () => void): this;
        on(event: string, listener: (...args: unknown[]) => void): this;
        once(event: string, listener: (...args: unknown[]) => void): this;
        push(chunk: unknown, encoding?: string): boolean;
        removeListener(event: string, listener: (...args: unknown[]) => void): this;
        write(chunk: unknown, cb?: (err?: Error | null) => void): boolean;
    }

    export class Readable extends Duplex {}
    export class Writable extends Duplex {}
}
