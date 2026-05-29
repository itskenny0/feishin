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

import mqtt from 'mqtt';

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

export interface PeerClientStartArgs {
    /** External broker password — only used when non-empty. Overrides the
     *  default room-key-as-password used against the embedded broker. */
    brokerPassword?: string;
    /** Broker WS/WSS URL. */
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
    // Ignore our own retained frames coming back to us on (re)subscribe.
    if (parsed.addr.peerId === s.selfAddress.peerId) return;

    const frame: null | PeerFrame = codec.decode(payload);
    if (!frame) {
        warn('dropped malformed frame', { topic });
        return;
    }

    if (parsed.leaf === 'presence' && frame.t === 'presence') {
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
        s.events.onState?.(parsed.addr, frame);
        return;
    }
    if (parsed.leaf === 'cmd' && frame.t === 'cmd') {
        log('command', { from: parsed.addr.peerId, k: frame.k });
        s.events.onCommand?.(parsed.addr, frame);
        return;
    }
    if (parsed.leaf === 'ping' && frame.t === 'ping') {
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
        s.events.onPong?.(parsed.addr, frame);
        return;
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
    log('connecting', {
        auth: useExternalAuth ? 'external' : 'embedded',
        brokerUrl: loggedUrl,
        peerId: args.peerId,
    });

    // Guard mqtt.connect — a malformed URL throws synchronously and the
    // previous code let that bubble up through the React effect, crashing
    // the renderer to a blackscreen. Surface the failure as a normal
    // disconnected event instead so the diagnostics page + UI banner can
    // show it without taking the whole app down.
    let client: MqttClient;
    try {
        client = mqtt.connect(resolvedUrl, opts);
    } catch (err) {
        warn('connect failed', { brokerUrl: loggedUrl, err: (err as Error).message });
        events.onConnectionChange?.('disconnected');
        return;
    }

    const newSession: ActiveSession = {
        args,
        client,
        events,
        selfAddress,
    };
    session = newSession;

    client.on('connect', () => {
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
    const t0 = performance.now();
    log('publish cmd', { k: command.k, topic });
    // Command frames are intentionally QoS 0: idempotent on the receiver
    // and the state echo is the source of truth, so the PUBACK round-trip
    // was added latency without correctness. We still log broker-side
    // failures and emit the perf mark so the diagnostic story stays clean.
    session.client.publish(
        topic,
        Buffer.from(codec.encode(command)),
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
