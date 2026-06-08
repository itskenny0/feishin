/**
 * Derive the WebSocket URL the renderer MQTT client should use to reach the
 * locally-running embedded broker.
 *
 * The Connect wizard's "embedded" tier starts an aedes broker in the main
 * process (see `src/main/features/core/peer-broker/index.ts`) but persists
 * `peerSync.brokerUrl` as an empty string — there is no user-typed URL for an
 * auto-started local broker. Without this helper the connect hook treats the
 * empty `brokerUrl` as "not configured" and never connects, so the embedded
 * tier appears completely dead even though the broker is up. We reconstruct a
 * `ws(s)://host:port` URL from the same `peerSync.broker` config the broker was
 * started with.
 *
 * Host handling: the broker listens on `0.0.0.0` (all interfaces) by default,
 * but the renderer connects to it on the same machine, so a wildcard/unspecified
 * host must be mapped to loopback. A real LAN IP or hostname is passed through;
 * a bare IPv6 literal is bracketed for URL validity.
 */

export interface EmbeddedBrokerConfig {
    host?: string;
    port?: number;
    tlsCertPath?: string;
    tlsKeyPath?: string;
}

const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 8083;

/** Hosts that mean "listen on everything" — the client must dial loopback instead. */
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '0:0:0:0:0:0:0:0', '*', '::', '[::]']);

const normalizeHost = (host?: string): string => {
    const trimmed = (host ?? '').trim();
    if (WILDCARD_HOSTS.has(trimmed)) return LOOPBACK;
    return trimmed;
};

/** Bare IPv6 literals must be bracketed inside a URL authority. */
const formatHostForUrl = (host: string): string => {
    if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
    return host;
};

/**
 * Build the `ws://` / `wss://` URL for the embedded broker, or `null` when no
 * config is available. TLS is inferred from the presence of both a cert and a
 * key path (the broker only enables HTTPS when both are set).
 */
export const resolveEmbeddedBrokerUrl = (
    config: EmbeddedBrokerConfig | null | undefined,
): null | string => {
    if (!config) return null;
    const host = formatHostForUrl(normalizeHost(config.host));
    const port = config.port && config.port > 0 ? config.port : DEFAULT_PORT;
    const scheme = config.tlsCertPath && config.tlsKeyPath ? 'wss' : 'ws';
    return `${scheme}://${host}:${port}`;
};
