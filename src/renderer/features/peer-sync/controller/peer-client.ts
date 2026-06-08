/**
 * MQTT peer-sync client.
 *
 * One client per Feishin instance. Subscribes under our own Jellyfin user
 * id so two users on the same broker stay isolated by namespace. Publishes:
 *
 *   - retained presence on connect (LWT clears it on hard disconnect)
 *   - retained state snapshots whenever we are the target lane
 *   - non-retained command frames when we are controlling
 *
 * Subscribes to:
 *
 *   - every peer under the same userId (`feishin/v1/<user>/+/+`)
 *
 * That single wildcard covers all three leaves (cmd/state/presence) for
 * every peer the user owns; we route per-message by `parseTopic`.
 *
 * The transport selector is updated from incoming presence frames so the
 * dispatcher and state-mirror always agree which lane is alive.
 */
import type { IClientOptions, MqttClient } from 'mqtt';

import isElectron from 'is-electron';
import mqtt from 'mqtt';

import { isInboundApplyActive } from '/@/renderer/features/peer-sync/controller/peer-loop-guard';
import {
    forgetPeer,
    recordPresence,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { recordOutboundState } from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import { codec } from '/@/renderer/features/peer-sync/protocol/codec';
import {
    parseTopic,
    PeerAddress,
    topicFor,
    userPeersWildcard,
} from '/@/renderer/features/peer-sync/protocol/topics';
import {
    PeerCommand,
    PeerFrame,
    PeerPong,
    PeerPresence,
    PeerState,
    PROTOCOL_VERSION,
} from '/@/renderer/features/peer-sync/types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);
const warn = (...args: unknown[]) => console.warn('[peer-sync]', ...args);

/**
 * Accept a bare host, host:port, or full ws/wss/mqtt/mqtts URL and return
 * a URL mqtt.js can parse. The previous code passed the raw setting straight
 * to mqtt.connect, so a user typing `192.168.1.5` on the Android settings
 * page (without a scheme) crashed the renderer with an unhandled URL parse
 * throw — visible as a blackscreen after the wizard finished.
 *
 * Rules:
 *   - already has a scheme? parse via URL() and strip embedded
 *     username/password so credentials never leak into the diagnostics
 *     ring buffer when we log the URL verbatim.
 *   - looks like `host:port`? default to `ws://` (mqtt.js will pick
 *     port 8083 / 8084 if absent).
 *   - everything else? default to `ws://<input>:8083`.
 */
export const normalizeBrokerUrl = (raw: string): string => {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) return trimmed;
    if (/^(ws|wss|mqtt|mqtts):\/\//i.test(trimmed)) {
        // Only re-serialise when we actually need to drop creds — round-tripping
        // through `URL` lowercases the scheme and tacks on a trailing slash,
        // which would surprise callers that compare strings.
        try {
            const parsed = new URL(trimmed);
            if (!parsed.username && !parsed.password) return trimmed;
            parsed.username = '';
            parsed.password = '';
            return parsed.toString();
        } catch {
            // Malformed scheme'd URL — let mqtt.connect throw with its
            // own error; the caller already catches connect failures.
            return trimmed;
        }
    }
    // Bare IPv6 must be bracketed inside a URL — caller responsible.
    if (/^[a-z0-9.-]+:\d{2,5}(\/.*)?$/i.test(trimmed)) return `ws://${trimmed}`;
    return `ws://${trimmed}:8083`;
};

/**
 * Mask embedded credentials in a URL for log output. Returns the URL with
 * `user:pass@` replaced by `***:***@` if present so log lines can show that
 * credentials are configured without revealing them. Pure log helper — the
 * value passed to mqtt.connect always goes through normalizeBrokerUrl.
 */
export const redactBrokerUrl = (url: string): string => {
    const trimmed = (url ?? '').trim();
    if (!trimmed) return trimmed;
    if (!/^(ws|wss|mqtt|mqtts):\/\//i.test(trimmed)) return trimmed;
    try {
        const parsed = new URL(trimmed);
        if (!parsed.username && !parsed.password) return trimmed;
        parsed.username = '***';
        parsed.password = '***';
        return parsed.toString();
    } catch {
        return trimmed;
    }
};

/** Transport preference for the MQTT lane. 'auto' resolves to the existing
 *  WebSocket path on web/Electron and anywhere the native TCP plugin isn't
 *  present; on Android it upgrades to raw TCP when the broker URL carries an
 *  `mqtt://`/`mqtts://` scheme. 'ws' forces WebSocket; 'tcp' forces raw TCP
 *  (Android only — falls back to WS if the plugin is unavailable). */
export type PeerSyncTransport = 'auto' | 'tcp' | 'ws';

/**
 * Minimal view of the Capacitor global the runtime injects on native
 * platforms. We read it off `globalThis` rather than statically importing
 * `@capacitor/core` so the peer-client stays decoupled and unit-testable, and
 * so the web/Electron bundles don't change their behaviour at all (the global
 * is simply absent there → every check returns the WS path). `registerPlugin`
 * is present whenever Capacitor's runtime is loaded.
 */
interface CapacitorGlobal {
    getPlatform?: () => string;
    isPluginAvailable?: (name: string) => boolean;
    registerPlugin?: <T>(name: string) => T;
}

const getCapacitor = (): CapacitorGlobal | undefined => {
    try {
        return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
    } catch {
        return undefined;
    }
};

const isAndroidPlatform = (): boolean => {
    const cap = getCapacitor();
    try {
        return cap?.getPlatform?.() === 'android';
    } catch {
        return false;
    }
};

const isTcpPluginAvailable = (): boolean => {
    const cap = getCapacitor();
    try {
        return Boolean(cap?.isPluginAvailable?.('TcpSocket'));
    } catch {
        return false;
    }
};

/**
 * Minimal view of the Electron preload bridge the desktop app injects. We read
 * it off `window.api.tcpSocket` rather than statically importing preload types
 * so the renderer module stays portable to the web bundle (where `window.api`
 * is absent). Present iff the main-process TCP socket feature is registered.
 */
interface ElectronApiGlobal {
    tcpSocket?: import('/@/renderer/features/peer-sync/transport/native-tcp-stream').ElectronTcpSocketBridge;
}

const getElectronTcpBridge = ():
    | import('/@/renderer/features/peer-sync/transport/native-tcp-stream').ElectronTcpSocketBridge
    | undefined => {
    try {
        if (!isElectron()) return undefined;
        return (globalThis as { api?: ElectronApiGlobal }).api?.tcpSocket;
    } catch {
        return undefined;
    }
};

const isElectronTcpBridgeAvailable = (): boolean => Boolean(getElectronTcpBridge());

/** Runtime environment for transport resolution. Injected in tests; defaults
 *  probe the live globals. `pluginAvailable` is the Android Capacitor
 *  `TcpSocket` plugin; `bridgeAvailable` is the Electron `window.api.tcpSocket`
 *  IPC bridge. Either one (on its respective platform) enables raw TCP. */
export interface TransportEnv {
    android: boolean;
    /** Electron main-process TCP socket bridge present (`window.api.tcpSocket`). */
    bridgeAvailable: boolean;
    electron: boolean;
    /** Android Capacitor `TcpSocket` plugin registered. */
    pluginAvailable: boolean;
}

const defaultTransportEnv = (): TransportEnv => ({
    android: isAndroidPlatform(),
    bridgeAvailable: isElectronTcpBridgeAvailable(),
    electron: isElectron(),
    pluginAvailable: isTcpPluginAvailable(),
});

/**
 * Resolve the effective transport given the user preference, the broker URL,
 * and the runtime environment. The native TCP path is selected ONLY when both
 * a transport is wanted AND the platform can provide a raw socket:
 *   - a transport is "wanted" when the user explicitly chose 'tcp', OR they
 *     left it on 'auto' and the broker URL carries an `mqtt://`/`mqtts://`
 *     scheme; AND
 *   - raw TCP is reachable when EITHER (Android && Capacitor TcpSocket plugin
 *     available) OR (Electron && the main-process IPC bridge present).
 * In every other case — web/PWA (no raw-socket API), missing plugin/bridge,
 * 'ws', or 'auto' with a ws/bare URL — we return 'ws', byte-for-byte the
 * existing behaviour. Web/PWA can NEVER reach raw TCP and always uses WS.
 */
export const resolveEffectiveTransport = (
    pref: PeerSyncTransport | undefined,
    brokerUrl: string,
    env: TransportEnv = defaultTransportEnv(),
): 'tcp' | 'ws' => {
    const transport = pref ?? 'auto';
    if (transport === 'ws') return 'ws';
    const isMqttScheme = /^mqtts?:\/\//i.test((brokerUrl ?? '').trim());
    const wantTcp = transport === 'tcp' || (transport === 'auto' && isMqttScheme);
    if (!wantTcp) return 'ws';
    // wantTcp — honour it only where a raw socket is actually available.
    const androidTcp = env.android && env.pluginAvailable;
    const electronTcp = env.electron && env.bridgeAvailable;
    if (androidTcp || electronTcp) return 'tcp';
    if (!env.android && !env.electron) {
        // Web/PWA: no raw-socket API exists in the browser. Always WS.
        warn('tcp transport requested in browser/PWA; falling back to ws (no raw-socket API)', {
            brokerUrl,
        });
        return 'ws';
    }
    warn('tcp transport requested but no raw-socket provider available; falling back to ws', {
        brokerUrl,
    });
    return 'ws';
};

/**
 * Parse a broker URL into the host/port/tls a raw TCP socket needs. Defaults
 * the port to 1883 (mqtt) / 8883 (mqtts) when absent, matching the standard
 * MQTT listener ports brokers expose on raw TCP.
 *
 * S1-A: a `ws://`/`wss://` URL points at the broker's WebSocket listener
 * (typically 8083/8084), which speaks the HTTP Upgrade handshake — NOT raw
 * MQTT control bytes. Opening a raw socket to that port and writing MQTT bytes
 * either gets reset (→ perpetual 4s reconnect storm) or hangs until
 * connectTimeout. `resolveEffectiveTransport` lets an explicit `pref='tcp'`
 * win without a scheme check, so a user who set transport=tcp in settings but
 * typed a `ws://` URL would land here. We must NOT carry the WS port as a raw
 * MQTT port: re-map the scheme to its raw-MQTT equivalent and DROP the WS port
 * so we fall back to the standard 1883/8883 listener (`ws→mqtt:1883`,
 * `wss→mqtts:8883`). A warn surfaces the mis-config.
 */
export const parseTcpTarget = (
    brokerUrl: string,
): null | { host: string; port: number; tls: boolean } => {
    const trimmed = (brokerUrl ?? '').trim();
    if (!trimmed) return null;
    const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `mqtt://${trimmed}`;
    try {
        const url = new URL(withScheme);
        const scheme = url.protocol.replace(/:$/, '').toLowerCase();
        const isWsScheme = scheme === 'ws' || scheme === 'wss';
        // ws(s) → raw MQTT: tls follows the secure variant; the WS port is
        // explicitly discarded (it's the HTTP-Upgrade listener, not raw MQTT).
        const tls = isWsScheme ? scheme === 'wss' : /^(mqtts|ssl|tls)$/i.test(scheme);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (!host) return null;
        if (isWsScheme) {
            warn('tcp transport given a ws(s):// URL; re-mapping to raw MQTT port', {
                brokerUrl: redactBrokerUrl(brokerUrl),
                port: tls ? 8883 : 1883,
            });
            return { host, port: tls ? 8883 : 1883, tls };
        }
        const port = url.port ? Number(url.port) : tls ? 8883 : 1883;
        if (!Number.isFinite(port) || port <= 0) return null;
        return { host, port, tls };
    } catch {
        return null;
    }
};

export interface PeerClientStartArgs {
    /** External broker password — only used when non-empty. Overrides the
     *  default room-key-as-password used against the embedded broker. */
    brokerPassword?: string;
    /** Broker WS/WSS/MQTT/MQTTS URL. */
    brokerUrl: string;
    /** External broker username — only used when non-empty. Overrides the
     *  default Jellyfin-user-id-as-username used against the embedded
     *  broker. */
    brokerUsername?: string;
    /** This client's Jellyfin Sessions deviceId. Published in our presence
     *  frame so remote picker UIs can bridge "this Jellyfin device row" to
     *  "this MQTT peer" and route commands over MQTT instead of Jellyfin. */
    jellyfinDeviceId?: string;
    /** Our own peer identifier — published as our presence/state owner. */
    peerId: string;
    /** Shared room key — derived into the MQTT password so an empty/typo'd
     *  key cannot accidentally join another room. */
    roomKey: string;
    /** Optional TLS hint — used to set protocol / rejectUnauthorized. */
    tls?: boolean;
    /** Transport preference. Defaults to 'auto'. */
    transport?: PeerSyncTransport;
    /** Jellyfin user id we scope the namespace to. */
    userId: string;
}

export interface PeerEvents {
    onCommand?: (from: PeerAddress, cmd: PeerCommand) => void;
    onConnectionChange?: (status: 'connected' | 'disconnected') => void;
    onPong?: (from: PeerAddress, pong: PeerPong) => void;
    onPresence?: (from: PeerAddress, presence: PeerPresence) => void;
    onState?: (from: PeerAddress, state: PeerState) => void;
}

interface ActiveSession {
    args: PeerClientStartArgs;
    client: MqttClient;
    events: PeerEvents;
    selfAddress: PeerAddress;
}

let session: ActiveSession | null = null;

/**
 * Small wrapper that publishes with a callback so a broker-side failure (out
 * of namespace, ACL denial, transport hiccup mid-publish) gets logged instead
 * of vanishing. Body is intentionally minimal — no retry, no queue. mqtt.js
 * already handles in-flight redelivery for QoS≥1.
 */
const publishWithErrorLog = (
    client: MqttClient,
    topic: string,
    payload: Buffer,
    opts: Parameters<MqttClient['publish']>[2],
    context: string,
): void => {
    client.publish(topic, payload, opts, (err) => {
        if (err) warn(`${context} publish failed`, { err: err.message, topic });
    });
};

const buildLwt = (selfAddress: PeerAddress, jellyfinDeviceId: string | undefined) => ({
    // mqtt.js types require a node Buffer (or string) here; Uint8Array
    // bytes get rejected even though Buffer is itself a Uint8Array.
    payload: Buffer.from(
        codec.encode({
            ...(jellyfinDeviceId ? { dev: jellyfinDeviceId } : {}),
            online: false,
            t: 'presence',
            ts: Date.now(),
            v: PROTOCOL_VERSION,
        }),
    ),
    qos: 1 as const,
    retain: true,
    topic: topicFor(selfAddress, 'presence'),
});

const handleMessage = (s: ActiveSession, topic: string, payload: Uint8Array): void => {
    const parsed = parseTopic(topic);
    if (!parsed) return; // not ours / wrong shape — drop silently

    const frame: null | PeerFrame = codec.decode(payload);
    if (!frame) {
        warn('dropped malformed frame', { topic });
        return;
    }

    // Two addressing models share the wildcard subscription:
    //  - presence/state are published on the SENDER's own topic, so a frame on
    //    OUR topic is our own retained echo coming back on (re)subscribe — drop.
    //  - cmd/ping are ADDRESSED to a peer (published on the RECIPIENT's topic),
    //    so we act ONLY on frames addressed to us; the real sender of a command
    //    rides in `src` (the topic names the target, not the source). Filtering
    //    these as "self" here is what previously dropped every inbound command.
    const isSelfTopic = parsed.addr.peerId === s.selfAddress.peerId;

    if (parsed.leaf === 'presence' && frame.t === 'presence') {
        if (isSelfTopic) return; // our own retained presence echo
        // Always tell the selector — that's how the dispatcher knows which
        // lane is alive for this peer. The events hook is for UI only.
        // `dev` (publisher's Jellyfin Sessions deviceId, optional) populates
        // the reverse map so the picker can bridge a Jellyfin device row
        // back to this peer.
        recordPresence(parsed.addr.peerId, frame.online, Date.now(), frame.dev);
        log('presence', { dev: frame.dev, online: frame.online, peerId: parsed.addr.peerId });
        s.events.onPresence?.(parsed.addr, frame);
        return;
    }
    if (parsed.leaf === 'state' && frame.t === 'state') {
        if (isSelfTopic) return; // our own retained state echo
        s.events.onState?.(parsed.addr, frame);
        return;
    }
    if (parsed.leaf === 'cmd' && frame.t === 'cmd') {
        if (!isSelfTopic) return; // command addressed to a different peer
        const fromPeerId =
            typeof frame.src === 'string' && frame.src.length > 0 ? frame.src : parsed.addr.peerId;
        const from = { peerId: fromPeerId, userId: parsed.addr.userId };
        log('command', { from: fromPeerId, k: frame.k });
        s.events.onCommand?.(from, frame);
        return;
    }
    if (parsed.leaf === 'ping' && frame.t === 'ping') {
        if (!isSelfTopic) return; // ping addressed to a different peer
        // Echo it back as a pong on our own topic so the sender can measure
        // RTT. The pong carries the original id so out-of-order probes are
        // resolved by the sender's pending map.
        const pong = {
            id: frame.id,
            t: 'pong' as const,
            ts: Date.now(),
            v: PROTOCOL_VERSION,
        };
        publishWithErrorLog(
            s.client,
            topicFor(s.selfAddress, 'pong'),
            Buffer.from(codec.encode(pong)),
            { qos: 0, retain: false },
            'pong',
        );
        return;
    }
    if (parsed.leaf === 'pong' && frame.t === 'pong') {
        if (isSelfTopic) return; // our own pong echo
        s.events.onPong?.(parsed.addr, frame);
        return;
    }
};

/** Lazily-resolved native TcpSocket plugin proxy, cached after first use.
 *  Sourced from the Android Capacitor plugin OR the Electron IPC bridge —
 *  whichever the platform provides. */
let cachedTcpPlugin:
    | import('/@/renderer/features/peer-sync/transport/native-tcp-stream').TcpSocketPlugin
    | null = null;

/**
 * Resolve a `TcpSocketPlugin` from whichever raw-socket provider this platform
 * offers, or null if none. Android → Capacitor `registerPlugin('TcpSocket')`;
 * Electron → an adapter over `window.api.tcpSocket`; web/PWA → null (WS only).
 * The Capacitor path takes precedence so a hybrid build prefers the native
 * plugin. Never throws.
 */
const resolveTcpPlugin = async (): Promise<
    import('/@/renderer/features/peer-sync/transport/native-tcp-stream').TcpSocketPlugin | null
> => {
    if (cachedTcpPlugin) return cachedTcpPlugin;
    // Android (Capacitor) first.
    try {
        const cap = getCapacitor();
        if (cap?.registerPlugin && isTcpPluginAvailable()) {
            cachedTcpPlugin =
                cap.registerPlugin<
                    import('/@/renderer/features/peer-sync/transport/native-tcp-stream').TcpSocketPlugin
                >('TcpSocket');
            if (cachedTcpPlugin) return cachedTcpPlugin;
        }
    } catch (err) {
        warn('capacitor TcpSocket registration failed', { err: (err as Error).message });
    }
    // Electron (IPC bridge) fallback.
    const bridge = getElectronTcpBridge();
    if (bridge) {
        const { createElectronTcpSocketPlugin } =
            await import('/@/renderer/features/peer-sync/transport/native-tcp-stream');
        cachedTcpPlugin = createElectronTcpSocketPlugin(bridge);
        return cachedTcpPlugin;
    }
    return null;
};

/**
 * Build an mqtt.js streamBuilder backed by the native TCP socket, or return
 * null if no provider is available (caller then falls back to WS). Never
 * throws — any failure logs + returns null so a missing provider can't crash.
 */
const buildNativeTcpStreamBuilder = async (
    brokerUrl: string,
    tls: boolean | undefined,
): Promise<(() => unknown) | null> => {
    const target = parseTcpTarget(brokerUrl);
    if (!target) {
        warn('tcp transport selected but broker URL did not parse; falling back to ws', {
            brokerUrl: redactBrokerUrl(brokerUrl),
        });
        return null;
    }
    try {
        const plugin = await resolveTcpPlugin();
        if (!plugin) return null;
        const { createNativeTcpStreamBuilder } =
            await import('/@/renderer/features/peer-sync/transport/native-tcp-stream');
        // `tls` on the URL scheme wins; the explicit tls hint is a fallback.
        const useTls = target.tls || tls === true;
        log('native-tcp transport selected', {
            host: target.host,
            port: target.port,
            tls: useTls,
        });
        return createNativeTcpStreamBuilder(plugin, {
            host: target.host,
            port: target.port,
            // rejectUnauthorized mirrors the WS path: strict unless tls hint
            // explicitly says otherwise (args.tls === false).
            rejectUnauthorized: tls !== false,
            tls: useTls,
        });
    } catch (err) {
        warn('failed to build native tcp transport; falling back to ws', {
            err: (err as Error).message,
        });
        return null;
    }
};

/**
 * Boot the peer-sync client. Idempotent — calling start while already
 * connected to the same broker is a no-op; differing args restart the
 * client.
 */
export const startPeerClient = (args: PeerClientStartArgs, events: PeerEvents = {}): void => {
    if (session) {
        const same =
            session.args.brokerUrl === args.brokerUrl &&
            session.args.userId === args.userId &&
            session.args.peerId === args.peerId &&
            session.args.roomKey === args.roomKey &&
            session.args.brokerUsername === args.brokerUsername &&
            session.args.brokerPassword === args.brokerPassword &&
            session.args.jellyfinDeviceId === args.jellyfinDeviceId &&
            session.args.transport === args.transport &&
            session.args.tls === args.tls;
        if (same) {
            session.events = events;
            // The new consumer missed the original connect/disconnect
            // events that fired against the previous events object — without
            // this synthetic replay the broker status pill stays blank after
            // a React remount (HMR, settings UI side trip) until the next
            // reconnect.
            events.onConnectionChange?.(session.client.connected ? 'connected' : 'disconnected');
            return;
        }
        stopPeerClient();
    }

    const selfAddress: PeerAddress = { peerId: args.peerId, userId: args.userId };
    const presenceTopic = topicFor(selfAddress, 'presence');

    // External brokers (HiveMQ Cloud, AWS IoT, a self-hosted mosquitto with
    // `allow_anonymous false`, etc.) need their own credentials. When the
    // user has supplied a brokerUsername we hand those through verbatim;
    // otherwise we fall back to the embedded-broker scheme of
    // userId-as-username + roomKey-as-password, which the aedes ACL relies
    // on. We don't try to do both — most brokers won't tolerate a username
    // they don't recognise even with the right credentials elsewhere.
    const useExternalAuth = Boolean(args.brokerUsername);
    const opts: IClientOptions = {
        clean: true,
        clientId: `feishin-${args.peerId}-${Math.random().toString(36).slice(2, 8)}`,
        connectTimeout: 10_000,
        keepalive: 30,
        password: useExternalAuth ? (args.brokerPassword ?? '') : args.roomKey,
        // aedes (our embedded broker) implements MQTT 3.1.1; pinning the
        // client to v4 avoids a CONNACK "Unacceptable protocol version"
        // bounce on the very first connect.
        protocolVersion: 4,
        reconnectPeriod: 4_000,
        rejectUnauthorized: args.tls !== false,
        username: useExternalAuth ? args.brokerUsername : args.userId,
        will: buildLwt(selfAddress, args.jellyfinDeviceId),
    };

    const resolvedUrl = normalizeBrokerUrl(args.brokerUrl);
    const loggedUrl = redactBrokerUrl(args.brokerUrl);
    const effectiveTransport = resolveEffectiveTransport(args.transport, args.brokerUrl);
    log('connecting', {
        auth: useExternalAuth ? 'external' : 'embedded',
        brokerUrl: loggedUrl,
        peerId: args.peerId,
        transport: effectiveTransport,
    });

    // Attach all listeners + bookkeeping once the MqttClient exists. Shared by
    // the synchronous WS path and the async native-TCP path so the lifecycle
    // (C3 stale-session guard, presence publish, message routing) is identical
    // regardless of transport.
    const wire = (client: MqttClient): void => {
        const newSession: ActiveSession = {
            args,
            client,
            events,
            selfAddress,
        };
        session = newSession;

        wireClient(client, newSession, {
            args,
            events,
            loggedUrl,
            presenceTopic,
            selfAddress,
        });
    };

    if (effectiveTransport === 'tcp') {
        // Native TCP path (Android only). Build the streamBuilder asynchronously
        // (dynamic import keeps the native-stream code out of the WS bundles),
        // then construct the client with it. On ANY failure we fall back to the
        // synchronous WS path so a missing/broken plugin never strands the user.
        void buildNativeTcpStreamBuilder(args.brokerUrl, args.tls)
            .then((streamBuilder) => {
                // The session might have been torn down / superseded while we
                // were awaiting the dynamic import. Bail if so. S2-C: the guard
                // must ALSO bail when the session was torn down to null (kill
                // switch / unmount fired during the dynamic import) — not just
                // when a fresh start superseded us. `session?.args !== args`
                // bails on null (`undefined !== args` → true), closing the
                // native-TCP analogue of the C3 resurrection window. The
                // previous `session && session.args !== args` let a null session
                // fall through and resurrect the just-torn-down subsystem on TCP.
                if (session?.args !== args) {
                    log('native-tcp build superseded/torn-down before connect; dropping');
                    return;
                }
                if (!streamBuilder) {
                    log('native-tcp unavailable; using ws transport');
                    connectWsAndWire(resolvedUrl, opts, loggedUrl, events, wire);
                    return;
                }
                try {
                    // mqtt's MqttClient takes (streamBuilder, options). The
                    // published types only type `connect(url, opts)`, so cast.
                    const MqttClientCtor = (
                        mqtt as unknown as {
                            MqttClient: new (sb: unknown, o: IClientOptions) => MqttClient;
                        }
                    ).MqttClient;
                    const client = new MqttClientCtor(streamBuilder, opts);
                    wire(client);
                } catch (err) {
                    warn('native-tcp client construct failed; falling back to ws', {
                        brokerUrl: loggedUrl,
                        err: (err as Error).message,
                    });
                    connectWsAndWire(resolvedUrl, opts, loggedUrl, events, wire);
                }
            })
            .catch((err) => {
                // Defensive teardown guard mirroring the .then success path
                // (S2-C). buildNativeTcpStreamBuilder already swallows its own
                // failures (logs + returns null, which the .then guard above
                // handles), so this .catch only fires on an UNEXPECTED throw in
                // the chain (e.g. a synchronous throw from the .then handler).
                // Even then, never resurrect a session that was torn down or
                // superseded while we were off the synchronous path.
                if (session?.args !== args) {
                    log('native-tcp setup failed but session superseded/torn-down; dropping');
                    return;
                }
                warn('native-tcp transport setup failed; falling back to ws', {
                    brokerUrl: loggedUrl,
                    err: (err as Error).message,
                });
                connectWsAndWire(resolvedUrl, opts, loggedUrl, events, wire);
            });
        return;
    }

    // WebSocket path — unchanged from before. Synchronous; the existing tests
    // assert mqtt.connect is called immediately here.
    connectWsAndWire(resolvedUrl, opts, loggedUrl, events, wire);
};

/**
 * Connect over WebSocket and hand the client to `wire`. Guards mqtt.connect —
 * a malformed URL throws synchronously and the previous code let that bubble
 * up through the React effect, crashing the renderer to a blackscreen. Surface
 * the failure as a normal disconnected event instead so the diagnostics page +
 * UI banner can show it without taking the whole app down.
 */
const connectWsAndWire = (
    resolvedUrl: string,
    opts: IClientOptions,
    loggedUrl: string,
    events: PeerEvents,
    wire: (client: MqttClient) => void,
): void => {
    let client: MqttClient;
    try {
        client = mqtt.connect(resolvedUrl, opts);
    } catch (err) {
        warn('connect failed', { brokerUrl: loggedUrl, err: (err as Error).message });
        events.onConnectionChange?.('disconnected');
        return;
    }
    wire(client);
};

interface WireContext {
    args: PeerClientStartArgs;
    events: PeerEvents;
    loggedUrl: string;
    presenceTopic: string;
    selfAddress: PeerAddress;
}

/** Attach the MqttClient event handlers. Behaviour is transport-agnostic. */
const wireClient = (client: MqttClient, newSession: ActiveSession, ctx: WireContext): void => {
    const { args, events, loggedUrl, presenceTopic } = ctx;

    client.on('connect', () => {
        // A late CONNACK can fire after stopPeerClient() tore us down (kill
        // switch flipped mid-handshake) or after a fresh startPeerClient
        // replaced the session. removeAllListeners() in stopPeerClient should
        // detach this handler, but guard anyway so a torn-down/superseded
        // session can never resurrect itself by subscribing + publishing
        // presence. See C3.
        if (session !== newSession) {
            warn('ignoring connect on stale/torn-down session', { brokerUrl: loggedUrl });
            return;
        }
        log('connected', { brokerUrl: loggedUrl });
        events.onConnectionChange?.('connected');
        const sub = userPeersWildcard(args.userId);
        client.subscribe(sub, { qos: 1 }, (err) => {
            if (err) {
                warn('subscribe failed', { err: err.message, topic: sub });
                return;
            }
            log('subscribed', { topic: sub });
        });
        // Publish our presence as online + retained so peers that arrive
        // later learn we exist immediately. The `dev` field carries our
        // Jellyfin Sessions deviceId so the receiver can bridge "Jellyfin
        // device X" to "MQTT peer Y" and upgrade the command lane.
        const onlineFrame = codec.encode({
            ...(args.jellyfinDeviceId ? { dev: args.jellyfinDeviceId } : {}),
            online: true,
            t: 'presence',
            ts: Date.now(),
            v: PROTOCOL_VERSION,
        });
        publishWithErrorLog(
            client,
            presenceTopic,
            Buffer.from(onlineFrame),
            { qos: 1, retain: true },
            'presence',
        );
        log('presence published', { topic: presenceTopic });
    });

    client.on('message', (topic, payload) => {
        const s = session;
        if (!s) return;
        handleMessage(s, topic, payload);
    });

    client.on('reconnect', () => {
        log('reconnect attempt', { brokerUrl: loggedUrl });
    });

    client.on('close', () => {
        log('disconnected', { brokerUrl: loggedUrl });
        events.onConnectionChange?.('disconnected');
    });

    client.on('error', (err) => {
        warn('client error', { err: err.message });
    });
};

const perfDebug = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('perf.connect') === '1';
    } catch {
        return false;
    }
};

const perfMark = (label: string, payload: Record<string, unknown>): void => {
    if (!perfDebug()) return;
    console.info('[perf.connect]', label, { ts: performance.now(), ...payload });
};

/**
 * Publish a command frame to `target`. No-op if the client is down.
 *
 * QoS 0 on purpose. The previous QoS 1 added a PUBACK round trip that the
 * mqtt.js client serialises through its outgoing-store — under bursts (drag
 * the volume slider, mash play/pause) the queue head-of-line blocks the
 * trailing values from leaving the socket until the broker has ack'd the
 * head. Commands are idempotent at the application layer (the next state
 * frame always carries truth), so dropping QoS to 0 turns the wire path
 * into pure fire-and-forget and pegs the publish at <1ms LAN. Retain stays
 * off so a stale command can't sit on the topic.
 */
export const publishCommand = (target: PeerAddress, command: PeerCommand): void => {
    if (!session) return;
    const topic = topicFor(target, 'cmd');
    // Stamp the real sender. The command is published on the TARGET's topic for
    // addressing, so the recipient can't infer the source from the topic — `src`
    // is how its authorisation gate identifies who sent the command (and avoids
    // mistaking its own topic for a self-frame).
    const wire: PeerCommand = { ...command, src: session.selfAddress.peerId };
    const t0 = performance.now();
    log('publish cmd', { k: command.k, src: wire.src, topic });
    // Command frames are intentionally QoS 0: idempotent on the receiver
    // and the state echo is the source of truth, so the PUBACK round-trip
    // was added latency without correctness. We still log broker-side
    // failures and emit the perf mark so the diagnostic story stays clean.
    session.client.publish(
        topic,
        Buffer.from(codec.encode(wire)),
        { qos: 0, retain: false },
        (err) => {
            if (err) warn('cmd publish failed', { err: err.message, topic });
            perfMark('mqtt.publish.cmd', {
                durMs: Math.round(performance.now() - t0),
                k: command.k,
                ok: !err,
            });
        },
    );
};

/**
 * Publish our own retained state snapshot. Late subscribers get the latest
 * via MQTT's retained-message replay.
 */
export const publishOwnState = (state: PeerState): void => {
    if (!session) return;
    // Consult the loop guard at the single publish chokepoint. The receiver
    // opens the inbound-apply window (markInboundApply) whenever it applies a
    // peer command; suppressing our own-state publish during that window stops
    // the echo loop the guard was built to prevent (peer-loop-guard.ts). No
    // live publisher subscribes the player store to this path yet, so this is
    // currently latent — but it makes the guard correct the moment one is
    // wired. See D1.
    if (isInboundApplyActive()) {
        log('skip state publish: inbound-apply window');
        return;
    }
    const topic = topicFor(session.selfAddress, 'state');
    publishWithErrorLog(
        session.client,
        topic,
        Buffer.from(codec.encode(state)),
        { qos: 1, retain: true },
        'state',
    );
    recordOutboundState(session.selfAddress.peerId, state);
};

/**
 * Republish our retained `online: true` presence frame (SEV-1 heartbeat).
 *
 * Presence is otherwise published exactly once — inside the `connect` handler —
 * so a peer's `lastSeenAt` in every OTHER instance's transport-selector freezes
 * at connect time and ages out after `MQTT_PRESENCE_TTL_MS` (12 s), silently
 * dropping the MQTT lane back to Jellyfin for a peer that is still fully
 * connected. A periodic retained heartbeat at ~TTL/2 keeps remote selectors
 * fresh and lets late joiners learn our live `dev` bridge immediately. No-op
 * when the client is down or not actually connected (a heartbeat published
 * while offline would just sit in mqtt.js's outgoing queue). Cheap retained
 * QoS-1 publish — same frame shape the connect handler sends.
 */
export const publishPresenceHeartbeat = (): void => {
    const s = session;
    if (!s || !s.client.connected) return;
    const frame = codec.encode({
        ...(s.args.jellyfinDeviceId ? { dev: s.args.jellyfinDeviceId } : {}),
        online: true,
        t: 'presence',
        ts: Date.now(),
        v: PROTOCOL_VERSION,
    });
    publishWithErrorLog(
        s.client,
        topicFor(s.selfAddress, 'presence'),
        Buffer.from(frame),
        { qos: 1, retain: true },
        'presence-heartbeat',
    );
};

/**
 * Send a liveness probe to a specific peer. The peer is expected to echo
 * back a Pong on its own pong topic. Returns the ping id so the caller can
 * match it against the subsequent onPong event.
 */
export const publishPing = (target: PeerAddress): null | string => {
    if (!session) return null;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const ping = { id, t: 'ping' as const, ts: Date.now(), v: PROTOCOL_VERSION };
    publishWithErrorLog(
        session.client,
        topicFor(target, 'ping'),
        Buffer.from(codec.encode(ping)),
        { qos: 0, retain: false },
        'ping',
    );
    return id;
};

/** True when we're connected to the broker right now. */
export const isPeerClientConnected = (): boolean => Boolean(session?.client?.connected);

/** Tear the session down. Clears our retained presence + state. */
export const stopPeerClient = (): void => {
    const s = session;
    if (!s) return;
    session = null;
    // Detach our event handlers before end() so the close/error/offline
    // events mqtt.js fires during teardown can't race a fresh
    // startPeerClient and flicker the new session's UI to 'disconnected'.
    // Done before the retained-clear publishes below, which use their own
    // per-publish callbacks rather than client-level listeners.
    try {
        s.client.removeAllListeners();
    } catch (err) {
        warn('stop listener cleanup failed', { err: (err as Error).message });
    }
    try {
        // Clear our retained frames so the next install of Feishin doesn't
        // see ghost presence from us. Both topics are deterministic from the
        // self address — no need to remember which ones we actually published.
        const empty = Buffer.alloc(0);
        publishWithErrorLog(
            s.client,
            topicFor(s.selfAddress, 'presence'),
            empty,
            { qos: 0, retain: true },
            'stop-presence',
        );
        publishWithErrorLog(
            s.client,
            topicFor(s.selfAddress, 'state'),
            empty,
            { qos: 0, retain: true },
            'stop-state',
        );
        // Tell the selector we no longer trust ourselves on the MQTT lane.
        forgetPeer(s.selfAddress.peerId);
    } catch (err) {
        warn('stop publish cleanup failed', { err: (err as Error).message });
    }
    s.client.end(true, undefined, () => {
        log('stopped');
    });
};

export interface TestBrokerConnectionOptions {
    /** Broker auth password (own-broker tier). */
    password?: string;
    /** S2-B: embedded-scheme room key (== broker password against the embedded
     *  broker, normally the Jellyfin username). Used as the CONNECT password
     *  only when no external `username` is supplied, mirroring the live path so
     *  the test gate faithfully predicts live-connect success against a broker
     *  that enforces the embedded userId/roomKey scheme. */
    roomKey?: string;
    /** Connection timeout in ms. Defaults to ~8s. */
    timeoutMs?: number;
    /** TLS hint — falls back to the URL scheme when undefined. */
    tls?: boolean;
    /** Transport preference; resolved exactly like the live connect path. */
    transport?: PeerSyncTransport;
    /** S2-B: embedded-scheme userId (== broker username against the embedded
     *  broker). Used as the CONNECT username only when no external `username`
     *  is supplied. */
    userId?: string;
    /** Broker auth username (own-broker tier). */
    username?: string;
}

/**
 * Probe a broker the same way the live client connects, but tear the probe
 * down immediately after the first CONNACK / error / timeout. Mirrors the
 * real path: resolveEffectiveTransport → native-TCP streamBuilder when 'tcp',
 * else mqtt.connect(normalizeBrokerUrl(url)). Uses reconnectPeriod:0 so a
 * refused broker fails fast instead of looping, and an external timer so a
 * broker that accepts the TCP/WS handshake but never sends CONNACK still
 * resolves. NEVER throws — always resolves `{ ok, error? }` and always tears
 * the client down (client.end(true)) and clears the timer.
 */
export const testBrokerConnection = async (
    brokerUrl: string,
    options: TestBrokerConnectionOptions = {},
): Promise<{ error?: string; ok: boolean }> => {
    const url = (brokerUrl ?? '').trim();
    if (!url) return { error: 'Broker URL is empty', ok: false };

    const timeoutMs = options.timeoutMs ?? 8_000;
    const loggedUrl = redactBrokerUrl(url);
    const useExternalAuth = Boolean(options.username);
    // S2-B: when no external username is supplied, fall back to the embedded
    // userId/roomKey scheme EXACTLY like the live connect path (startPeerClient:
    // username=args.userId, password=args.roomKey). Probing anonymously here
    // produced a false FAIL against an embedded/auth-enforcing broker (which
    // requires a non-empty username + password===roomKey) and a false PASS
    // against an anonymous broker, so the test gate didn't predict live connect.
    const opts: IClientOptions = {
        clean: true,
        clientId: `feishin-test-${Math.random().toString(36).slice(2, 10)}`,
        connectTimeout: timeoutMs,
        keepalive: 30,
        password: useExternalAuth ? (options.password ?? '') : options.roomKey,
        protocolVersion: 4,
        // No reconnect loop — a one-shot probe.
        reconnectPeriod: 0,
        rejectUnauthorized: options.tls !== false,
        username: useExternalAuth ? options.username : options.userId,
    };

    const effectiveTransport = resolveEffectiveTransport(options.transport, url);
    log('test connecting', { brokerUrl: loggedUrl, transport: effectiveTransport });

    return new Promise<{ error?: string; ok: boolean }>((resolve) => {
        let settled = false;
        let client: MqttClient | null = null;
        let timer: null | ReturnType<typeof setTimeout> = null;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                client?.removeAllListeners();
                client?.end(true);
            } catch {
                // best-effort teardown — the probe is one-shot.
            }
        };

        const finish = (result: { error?: string; ok: boolean }) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (result.ok) log('test ok', { brokerUrl: loggedUrl });
            else warn('test failed', { brokerUrl: loggedUrl, error: result.error });
            resolve(result);
        };

        timer = setTimeout(() => {
            finish({ error: `Timed out after ${Math.round(timeoutMs / 1000)}s`, ok: false });
        }, timeoutMs);

        const wireProbe = (c: MqttClient): void => {
            client = c;
            c.on('connect', () => finish({ ok: true }));
            c.on('error', (err) => finish({ error: err.message, ok: false }));
        };

        if (effectiveTransport === 'tcp') {
            void buildNativeTcpStreamBuilder(url, options.tls)
                .then((streamBuilder) => {
                    if (settled) return;
                    if (!streamBuilder) {
                        // Plugin unavailable — fall back to a WS probe, mirroring
                        // the live connect fallback chain.
                        try {
                            wireProbe(mqtt.connect(normalizeBrokerUrl(url), opts));
                        } catch (err) {
                            finish({ error: (err as Error).message, ok: false });
                        }
                        return;
                    }
                    try {
                        const MqttClientCtor = (
                            mqtt as unknown as {
                                MqttClient: new (sb: unknown, o: IClientOptions) => MqttClient;
                            }
                        ).MqttClient;
                        wireProbe(new MqttClientCtor(streamBuilder, opts));
                    } catch (err) {
                        finish({ error: (err as Error).message, ok: false });
                    }
                })
                .catch((err) => finish({ error: (err as Error).message, ok: false }));
            return;
        }

        try {
            wireProbe(mqtt.connect(normalizeBrokerUrl(url), opts));
        } catch (err) {
            finish({ error: (err as Error).message, ok: false });
        }
    });
};
