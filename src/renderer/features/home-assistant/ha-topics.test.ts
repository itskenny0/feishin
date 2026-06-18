import { describe, expect, it } from 'vitest';

import {
    haArtTopic,
    haAvailabilityTopic,
    haCmdTopic,
    haCmdWildcard,
    haDiscoveryTopic,
    haNodeId,
    haStateTopic,
} from './ha-topics';

describe('ha-topics', () => {
    it('sanitizes the node id from the peer id', () => {
        expect(haNodeId('abc-123')).toBe('feishin_abc-123');
        expect(haNodeId('a/b+c#d e')).toBe('feishin_a_b_c_d_e');
        expect(haNodeId('')).toBe('feishin_unknown');
    });

    it('builds the topic surface', () => {
        const n = haNodeId('p1');
        expect(haAvailabilityTopic(n)).toBe('feishin/ha/feishin_p1/availability');
        expect(haStateTopic(n)).toBe('feishin/ha/feishin_p1/state');
        expect(haArtTopic(n)).toBe('feishin/ha/feishin_p1/art');
        expect(haCmdTopic(n, 'play')).toBe('feishin/ha/feishin_p1/cmd/play');
        expect(haCmdWildcard(n)).toBe('feishin/ha/feishin_p1/cmd/+');
        expect(haDiscoveryTopic('sensor', n, 'title')).toBe(
            'homeassistant/sensor/feishin_p1/title/config',
        );
    });
});
