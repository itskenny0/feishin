// Home Assistant MQTT autodiscovery payload builder.
//
// HA core has no MQTT media_player platform, so we model the player as ONE HA
// device built from supported building-block components (sensor/button/number/
// switch/select/image). Every component shares the same `device` block (so HA
// groups them under one device) and the same `availability_topic`. State-
// bearing components read a single retained JSON state topic via value_template
// (the efficient one-topic-many-entities pattern).

import type { HaCommandVerb } from './ha-topics';

import { haAvailabilityTopic, haCmdTopic, haDiscoveryTopic, haStateTopic } from './ha-topics';

export interface DiscoveryMsg {
    payload: string;
    topic: string;
}

interface Component {
    component: 'button' | 'image' | 'number' | 'select' | 'sensor' | 'switch';
    config: Record<string, unknown>;
    objectId: string;
}

const components = (nodeId: string): Component[] => {
    const state = haStateTopic(nodeId);
    const sensor = (
        objectId: string,
        name: string,
        field: string,
        extra: Record<string, unknown> = {},
    ): Component => ({
        component: 'sensor',
        config: { name, state_topic: state, value_template: `{{ value_json.${field} }}`, ...extra },
        objectId,
    });
    const button = (objectId: HaCommandVerb, name: string): Component => ({
        component: 'button',
        config: { command_topic: haCmdTopic(nodeId, objectId), name, payload_press: 'PRESS' },
        objectId,
    });
    return [
        sensor('state', 'State', 'state'),
        sensor('title', 'Title', 'title'),
        sensor('artist', 'Artist', 'artist'),
        sensor('album', 'Album', 'album'),
        sensor('position', 'Position', 'position', {
            device_class: 'duration',
            unit_of_measurement: 's',
        }),
        sensor('duration', 'Duration', 'duration', {
            device_class: 'duration',
            unit_of_measurement: 's',
        }),
        {
            component: 'image',
            config: { name: 'Artwork', url_template: '{{ value_json.artUrl }}', url_topic: state },
            objectId: 'artwork',
        },
        button('play', 'Play'),
        button('pause', 'Pause'),
        button('stop', 'Stop'),
        button('next', 'Next'),
        button('previous', 'Previous'),
        {
            component: 'number',
            config: {
                command_topic: haCmdTopic(nodeId, 'volume'),
                max: 100,
                min: 0,
                name: 'Volume',
                state_topic: state,
                value_template: '{{ value_json.volume }}',
            },
            objectId: 'volume',
        },
        {
            component: 'switch',
            config: {
                command_topic: haCmdTopic(nodeId, 'mute'),
                name: 'Mute',
                payload_off: 'false',
                payload_on: 'true',
                state_topic: state,
                value_template: '{{ value_json.muted }}',
            },
            objectId: 'mute',
        },
        {
            component: 'switch',
            config: {
                command_topic: haCmdTopic(nodeId, 'shuffle'),
                name: 'Shuffle',
                payload_off: 'false',
                payload_on: 'true',
                state_topic: state,
                value_template: '{{ value_json.shuffle }}',
            },
            objectId: 'shuffle',
        },
        {
            component: 'select',
            config: {
                command_topic: haCmdTopic(nodeId, 'repeat'),
                name: 'Repeat',
                options: ['off', 'all', 'one'],
                state_topic: state,
                value_template: '{{ value_json.repeat }}',
            },
            objectId: 'repeat',
        },
    ];
};

export const buildDiscovery = (nodeId: string, deviceName: string): DiscoveryMsg[] => {
    const device = {
        identifiers: [nodeId],
        manufacturer: 'Feishin',
        model: 'Music Player',
        name: deviceName || 'Feishin',
    };
    const availability_topic = haAvailabilityTopic(nodeId);
    return components(nodeId).map((c) => ({
        payload: JSON.stringify({
            ...c.config,
            availability_topic,
            device,
            unique_id: `${nodeId}_${c.objectId}`,
        }),
        topic: haDiscoveryTopic(c.component, nodeId, c.objectId),
    }));
};

// Empty retained payloads remove the entities from HA (explicit disable).
export const clearDiscovery = (nodeId: string): DiscoveryMsg[] =>
    components(nodeId).map((c) => ({
        payload: '',
        topic: haDiscoveryTopic(c.component, nodeId, c.objectId),
    }));
