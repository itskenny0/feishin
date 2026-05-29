// Ring-buffered console capture.
//
// Mobile users (Capacitor on Android / iOS) can't open devtools to see the
// console output. We monkey-patch the standard console methods at boot
// time and tee every call into a bounded in-memory buffer. The user opens
// "Show logs" in Settings → Library sync to view + copy the buffer.

import packageJson from '../../../package.json';

// Stamped onto every entry so screenshots sent for debugging immediately
// identify which build produced them. Falls back to the bare package
// version when the build pipeline hasn't injected a tag-specific value.
const BUILD_VERSION =
    (typeof process !== 'undefined' && process.env?.VITE_BUILD_VERSION) || packageJson.version;

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

// Pre-mount entries (anything logged before React has flushed createRoot)
// get a `[boot]` tag so a crash report makes it obvious whether the failure
// happened during early bootstrap (Buffer polyfill, store hydration, lazy
// chunk fetch) or after the app reached steady state. `markConsoleCaptureMounted`
// is called from app.tsx's AppShell first-mount effect.
let mounted = false;

const push = (level: ConsoleEntryLevel, args: unknown[]): void => {
    const tag = mounted ? '' : '[boot] ';
    const entry: ConsoleEntry = {
        args: `${tag}[v${BUILD_VERSION}] ${args.map(safeStringify).join(' ')}`,
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

export const markConsoleCaptureMounted = (): void => {
    mounted = true;
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

// Redact obvious secret-bearing query params and known credential field
// values before the buffer leaves the device. This runs at copy-to-clipboard
// time only — the in-memory buffer keeps the originals for live viewing —
// so a user pasting logs into an issue tracker doesn't ship their Jellyfin
// token or Subsonic salt to the world. The matchers are deliberately
// conservative: known param names + common JSON key shapes; this isn't a
// substitute for the API layer not logging credentials in the first place.
const SECRET_QUERY_PARAMS =
    /([?&](?:api_?key|token|access_?token|password|t|s|p|u|salt|sessionid|jellyfin-auth(?:orization)?)=)([^&\s"'<>]+)/gi;
const SECRET_JSON_FIELDS =
    /("(?:credential|ndCredential|password|token|accessToken|api_?key|salt|sessionId|jellyfin-auth(?:orization)?)"\s*:\s*")([^"]+)(")/gi;
const SECRET_AUTH_HEADER = /(MediaBrowser\s+(?:[A-Za-z]+="[^"]*"\s*,\s*)*Token=")([^"]+)(")/gi;

const redactSecrets = (text: string): string => {
    if (!text) return text;
    return text
        .replace(SECRET_QUERY_PARAMS, '$1[REDACTED]')
        .replace(SECRET_JSON_FIELDS, '$1[REDACTED]$3')
        .replace(SECRET_AUTH_HEADER, '$1[REDACTED]$3');
};

/**
 * Format the entire buffer as a single string for copy-to-clipboard. Secret
 * query params (api_key, token, sessionid, …) and credential JSON fields
 * are redacted to "[REDACTED]" so users sharing logs for debugging don't
 * accidentally leak their server credentials.
 */
export const formatConsoleBuffer = (): string => {
    return buffer
        .map((entry) => {
            const iso = new Date(entry.timestamp).toISOString();
            return `[${iso}] [${entry.level.toUpperCase()}] ${redactSecrets(entry.args)}`;
        })
        .join('\n');
};
