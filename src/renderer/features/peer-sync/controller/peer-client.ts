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
    /** Most recent retained snapshot we've published — used to clear on stop. */
    publishedStateTopic: null | string;
    selfAddress: PeerAddress;
}

let session: ActiveSession | null = null;

const buildLwt = (selfAddress: PeerAddress) => ({
    // mqtt.js types require a node Buffer (or string) here; Uint8Array
    // bytes get rejected even though Buffer is itself a Uint8Array.
    payload: Buffer.from(
        codec.encode({
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
        recordPresence(parsed.addr.peerId, frame.online);
        log('presence', { online: frame.online, peerId: parsed.addr.peerId });
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
        s.client.publish(topicFor(s.selfAddress, 'pong'), Buffer.from(codec.encode(pong)), {
            qos: 0,
            retain: false,
        });
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
            session.args.tls === args.tls;
        if (same) {
            session.events = events;
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
        will: buildLwt(selfAddress),
    };

    log('connecting', {
        auth: useExternalAuth ? 'external' : 'embedded',
        brokerUrl: args.brokerUrl,
        peerId: args.peerId,
    });

    const client = mqtt.connect(args.brokerUrl, opts);

    const newSession: ActiveSession = {
        args,
        client,
        events,
        publishedStateTopic: null,
        selfAddress,
    };
    session = newSession;

    client.on('connect', () => {
        log('connected', { brokerUrl: args.brokerUrl });
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
        // later learn we exist immediately.
        const onlineFrame = codec.encode({
            online: true,
            t: 'presence',
            ts: Date.now(),
            v: PROTOCOL_VERSION,
        });
        client.publish(presenceTopic, Buffer.from(onlineFrame), {
            qos: 1,
            retain: true,
        });
        log('presence published', { topic: presenceTopic });
    });

    client.on('message', (topic, payload) => {
        const s = session;
        if (!s) return;
        handleMessage(s, topic, payload);
    });

    client.on('reconnect', () => {
        log('reconnect attempt', { brokerUrl: args.brokerUrl });
    });

    client.on('close', () => {
        log('disconnected', { brokerUrl: args.brokerUrl });
        events.onConnectionChange?.('disconnected');
    });

    client.on('error', (err) => {
        warn('client error', { err: err.message });
    });
};

/** Publish a command frame to `target`. No-op if the client is down. */
export const publishCommand = (target: PeerAddress, command: PeerCommand): void => {
    if (!session) return;
    const topic = topicFor(target, 'cmd');
    log('publish cmd', { k: command.k, topic });
    session.client.publish(topic, Buffer.from(codec.encode(command)), {
        qos: 1,
        retain: false,
    });
};

/**
 * Publish our own retained state snapshot. Late subscribers get the latest
 * via MQTT's retained-message replay.
 */
export const publishOwnState = (state: PeerState): void => {
    if (!session) return;
    const topic = topicFor(session.selfAddress, 'state');
    session.publishedStateTopic = topic;
    session.client.publish(topic, Buffer.from(codec.encode(state)), {
        qos: 1,
        retain: true,
    });
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
    session.client.publish(topicFor(target, 'ping'), Buffer.from(codec.encode(ping)), {
        qos: 0,
        retain: false,
    });
    return id;
};

/** True when we're connected to the broker right now. */
export const isPeerClientConnected = (): boolean => Boolean(session?.client?.connected);

/** Tear the session down. Clears our retained presence + state. */
export const stopPeerClient = (): void => {
    const s = session;
    if (!s) return;
    session = null;
    try {
        // Clear our retained frames so the next install of Feishin doesn't
        // see ghost presence from us.
        const empty = Buffer.alloc(0);
        s.client.publish(topicFor(s.selfAddress, 'presence'), empty, {
            qos: 0,
            retain: true,
        });
        if (s.publishedStateTopic) {
            s.client.publish(s.publishedStateTopic, empty, { qos: 0, retain: true });
        }
        // Tell the selector we no longer trust anyone we'd been tracking
        // through this session.
        for (const peerId of [s.selfAddress.peerId]) forgetPeer(peerId);
    } catch (err) {
        warn('stop publish cleanup failed', { err: (err as Error).message });
    }
    s.client.end(true, undefined, () => {
        log('stopped');
    });
};

/** Re-export for tests so they can inject without IPC. */
export const __getSessionForTests = (): ActiveSession | null => session;
