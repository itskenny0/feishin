// Ring-buffered console capture.
//
// Mobile users (Capacitor on Android / iOS) can't open devtools to see the
// console output. We monkey-patch the standard console methods at boot
// time and tee every call into a bounded in-memory buffer. The user opens
// "Show logs" in Settings → Library sync to view + copy the buffer.

export interface ConsoleEntry {
    args: string;
    level: ConsoleEntryLevel;
    timestamp: number;
}

export type ConsoleEntryLevel = 'debug' | 'error' | 'info' | 'log' | 'warn';

const MAX_ENTRIES = 1000;

const buffer: ConsoleEntry[] = [];
const listeners = new Set<() => void>();

const safeStringify = (value: unknown): string => {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Error) {
        return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
    }
    try {
        return JSON.stringify(
            value,
            (_, v) => {
                if (typeof v === 'bigint') return v.toString();
                return v;
            },
            2,
        );
    } catch {
        try {
            return String(value);
        } catch {
            return '[unserialisable]';
        }
    }
};

const push = (level: ConsoleEntryLevel, args: unknown[]): void => {
    const entry: ConsoleEntry = {
        args: args.map(safeStringify).join(' '),
        level,
        timestamp: Date.now(),
    };
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
    for (const listener of listeners) {
        try {
            listener();
        } catch {
            /* listener errors must not break console.log itself */
        }
    }
};

let installed = false;
const originals: Partial<Record<ConsoleEntryLevel, (...args: unknown[]) => void>> = {};

/**
 * Wrap the global console methods so every call is teed into the buffer.
 * Idempotent — calling install() twice is a no-op. The original console
 * implementations stay in place; we only add the tee.
 */
export const installConsoleCapture = (): void => {
    if (installed) return;
    installed = true;
    if (typeof console === 'undefined') return;
    (['debug', 'error', 'info', 'log', 'warn'] as ConsoleEntryLevel[]).forEach((level) => {
        const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[
            level
        ];
        if (typeof original !== 'function') return;
        originals[level] = original.bind(console);
        (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (
            ...args: unknown[]
        ): void => {
            push(level, args);
            originals[level]?.(...args);
        };
    });
    push('info', [`[console-capture] installed (cap ${MAX_ENTRIES})`]);
};

export const getConsoleBuffer = (): readonly ConsoleEntry[] => buffer;

export const clearConsoleBuffer = (): void => {
    buffer.length = 0;
    for (const listener of listeners) {
        try {
            listener();
        } catch {
            /* swallow */
        }
    }
};

export const subscribeToConsoleBuffer = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/**
 * Format the entire buffer as a single string for copy-to-clipboard.
 */
export const formatConsoleBuffer = (): string => {
    return buffer
        .map((entry) => {
            const iso = new Date(entry.timestamp).toISOString();
            return `[${iso}] [${entry.level.toUpperCase()}] ${entry.args}`;
        })
        .join('\n');
};
