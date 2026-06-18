// Topic + node-id helpers for the Home Assistant MQTT bridge.
//
// Layout:
//   feishin/ha/<nodeId>/availability   (retained; LWT clears to "offline")
//   feishin/ha/<nodeId>/state          (retained JSON state snapshot)
//   feishin/ha/<nodeId>/cmd/<verb>     (HA → Feishin commands)
//   homeassistant/<component>/<nodeId>/<objectId>/config   (retained discovery)
//
// `nodeId` is derived from the stable per-install peerId so a single broker can
// host several Feishin devices without collision.

export type HaCommandVerb =
    | 'mute'
    | 'next'
    | 'pause'
    | 'play'
    | 'previous'
    | 'repeat'
    | 'seek'
    | 'shuffle'
    | 'stop'
    | 'volume';

const sanitize = (s: string): string => s.replace(/[\s/+#]/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_');

export const haNodeId = (peerId: string): string => `feishin_${sanitize(peerId) || 'unknown'}`;

export const haAvailabilityTopic = (nodeId: string): string => `feishin/ha/${nodeId}/availability`;

export const haStateTopic = (nodeId: string): string => `feishin/ha/${nodeId}/state`;

export const haCmdTopic = (nodeId: string, verb: HaCommandVerb): string =>
    `feishin/ha/${nodeId}/cmd/${verb}`;

export const haCmdWildcard = (nodeId: string): string => `feishin/ha/${nodeId}/cmd/+`;

export const haDiscoveryTopic = (component: string, nodeId: string, objectId: string): string =>
    `homeassistant/${component}/${nodeId}/${objectId}/config`;
