// Dedicated MQTT client for the Home Assistant bridge.
//
// A SEPARATE connection from peer-sync's client (distinct clientId), to the
// same broker/credentials read from the peerSync settings slice. On connect it
// publishes availability=online, the autodiscovery configs, and an initial
// state snapshot, then subscribes the command wildcard. On stop it clears the
// discovery (removing the HA device) and goes offline. Transport (ws/tcp) is
// resolved with the SAME helpers peer-sync uses so Android raw-TCP brokers work
// identically.

import type { IClientOptions, MqttClient } from 'mqtt';

import mqtt from 'mqtt';

import { startHaArtPublisher } from './ha-art';
import { applyHaCommand } from './ha-commands';
import { buildDiscovery, clearDiscovery } from './ha-discovery';
import { startHaStatePublisher } from './ha-state';
import {
    haArtTopic,
    haAvailabilityTopic,
    haCmdWildcard,
    type HaCommandVerb,
    haNodeId,
    haStateTopic,
} from './ha-topics';

import {
    buildNativeTcpStreamBuilder,
    normalizeBrokerUrl,
    resolveEffectiveTransport,
} from '/@/renderer/features/peer-sync/controller/peer-client';

const log = (...a: unknown[]) => console.info('[home-assistant]', ...a);
const warn = (...a: unknown[]) => console.warn('[home-assistant]', ...a);

export interface HaClientArgs {
    brokerPassword?: string;
    brokerUrl: string;
    brokerUsername?: string;
    deviceName: string;
    peerId: string;
    roomKey: string;
    tls?: boolean;
    transport?: 'auto' | 'tcp' | 'ws';
    userId: string;
}

interface HaSession {
    args: HaClientArgs;
    client: MqttClient;
    nodeId: string;
    stopArtPublisher?: () => void;
    stopPublisher?: () => void;
}

let session: HaSession | null = null;
let epoch = 0;

const buildOptions = (args: HaClientArgs, nodeId: string): IClientOptions => {
    const useExternalAuth = Boolean(args.brokerUsername);
    return {
        clean: true,
        clientId: `feishin-ha-${args.peerId}-${Math.random().toString(36).slice(2, 8)}`,
        connectTimeout: 10_000,
        keepalive: 30,
        password: useExternalAuth ? (args.brokerPassword ?? '') : args.roomKey,
        protocolVersion: 4,
        reconnectPeriod: 4_000,
        rejectUnauthorized: args.tls !== false,
        username: useExternalAuth ? args.brokerUsername : args.userId,
        will: {
            payload: Buffer.from('offline'),
            qos: 1,
            retain: true,
            topic: haAvailabilityTopic(nodeId),
        },
    };
};

const publish = (
    client: MqttClient,
    topic: string,
    payload: string,
    opts: { retain?: boolean } = {},
): void => {
    client.publish(topic, payload, { qos: 1, retain: opts.retain ?? false }, (err) => {
        if (err) warn('publish failed', { err: err.message, topic });
    });
};

const wire = (client: MqttClient, args: HaClientArgs, nodeId: string): void => {
    const s: HaSession = { args, client, nodeId };
    session = s;

    client.on('connect', () => {
        log('connected', { nodeId });
        publish(client, haAvailabilityTopic(nodeId), 'online', { retain: true });
        for (const msg of buildDiscovery(nodeId, args.deviceName)) {
            publish(client, msg.topic, msg.payload, { retain: true });
        }
        s.stopPublisher?.();
        s.stopPublisher = startHaStatePublisher((payload) =>
            publish(client, haStateTopic(nodeId), payload, { retain: true }),
        );
        s.stopArtPublisher?.();
        s.stopArtPublisher = startHaArtPublisher((base64) =>
            publish(client, haArtTopic(nodeId), base64, { retain: true }),
        );
        client.subscribe(haCmdWildcard(nodeId), { qos: 1 }, (err) => {
            if (err) warn('subscribe failed', { err: err.message });
        });
    });

    client.on('message', (topic, payload) => {
        const verb = topic.split('/').pop() as HaCommandVerb | undefined;
        if (!verb) return;
        try {
            applyHaCommand(verb, payload.toString());
        } catch (err) {
            warn('command apply failed', { err: (err as Error).message, verb });
        }
    });

    client.on('error', (err) => warn('client error', { err: err.message }));
    client.on('close', () => log('connection closed', { nodeId }));
};

export const startHaClient = (args: HaClientArgs): void => {
    // Idempotent: a re-start with identical args keeps the live connection.
    if (
        session &&
        session.args.brokerUrl === args.brokerUrl &&
        session.args.brokerUsername === args.brokerUsername &&
        session.args.brokerPassword === args.brokerPassword &&
        session.args.roomKey === args.roomKey &&
        session.args.deviceName === args.deviceName &&
        session.args.peerId === args.peerId &&
        session.args.userId === args.userId
    ) {
        return;
    }
    stopHaClient();
    const myEpoch = ++epoch;
    const nodeId = haNodeId(args.peerId);
    const opts = buildOptions(args, nodeId);
    const resolvedUrl = normalizeBrokerUrl(args.brokerUrl);
    const transport = resolveEffectiveTransport(args.transport, args.brokerUrl);
    log('connecting', { nodeId, transport });

    if (transport === 'tcp') {
        void buildNativeTcpStreamBuilder(args.brokerUrl, args.tls)
            .then((streamBuilder) => {
                if (epoch !== myEpoch) return; // superseded/stopped during await
                if (!streamBuilder) {
                    wire(mqtt.connect(resolvedUrl, opts), args, nodeId);
                    return;
                }
                const Ctor = (
                    mqtt as unknown as {
                        MqttClient: new (sb: unknown, o: IClientOptions) => MqttClient;
                    }
                ).MqttClient;
                wire(new Ctor(streamBuilder, opts), args, nodeId);
            })
            .catch((err) => {
                warn('native-tcp build failed; using ws', { err: (err as Error).message });
                if (epoch === myEpoch) wire(mqtt.connect(resolvedUrl, opts), args, nodeId);
            });
        return;
    }
    wire(mqtt.connect(resolvedUrl, opts), args, nodeId);
};

export const stopHaClient = (): void => {
    epoch += 1; // invalidate any in-flight async connect
    const s = session;
    session = null;
    if (!s) return;
    log('stopping', { nodeId: s.nodeId });
    s.stopPublisher?.();
    s.stopArtPublisher?.();
    try {
        // Remove the HA device + go offline (retained) before disconnecting.
        for (const msg of clearDiscovery(s.nodeId)) {
            s.client.publish(msg.topic, msg.payload, { qos: 1, retain: true });
        }
        s.client.publish(haAvailabilityTopic(s.nodeId), 'offline', { qos: 1, retain: true });
    } catch (err) {
        warn('stop cleanup failed', { err: (err as Error).message });
    }
    s.client.end(true);
};

export const isHaClientConnected = (): boolean => Boolean(session?.client.connected);
