import { describe, expect, it } from 'vitest';

import { buildDiscovery, clearDiscovery } from './ha-discovery';

describe('buildDiscovery', () => {
    const msgs = buildDiscovery('feishin_p1', 'Living Room');
    const byTopic = (t: string) => msgs.find((m) => m.topic === t)!;

    it('emits one config per component sharing device + availability', () => {
        // sensors(6) + image(1) + buttons(5) + number(1) + switches(2) + select(1) = 16
        expect(msgs).toHaveLength(16);
        for (const m of msgs) {
            const p = JSON.parse(m.payload);
            expect(p.device.identifiers).toEqual(['feishin_p1']);
            expect(p.device.name).toBe('Living Room');
            expect(p.availability_topic).toBe('feishin/ha/feishin_p1/availability');
            expect(String(p.unique_id).startsWith('feishin_p1_')).toBe(true);
        }
    });

    it('falls back to a default device name', () => {
        const p = JSON.parse(buildDiscovery('feishin_p1', '')[0].payload);
        expect(p.device.name).toBe('Feishin');
    });

    it('state sensors read the shared JSON state topic via value_template', () => {
        const title = JSON.parse(byTopic('homeassistant/sensor/feishin_p1/title/config').payload);
        expect(title.state_topic).toBe('feishin/ha/feishin_p1/state');
        expect(title.value_template).toContain('value_json.title');
    });

    it('buttons publish to their own command topic', () => {
        const next = JSON.parse(byTopic('homeassistant/button/feishin_p1/next/config').payload);
        expect(next.command_topic).toBe('feishin/ha/feishin_p1/cmd/next');
    });

    it('repeat select advertises the three modes', () => {
        const repeat = JSON.parse(byTopic('homeassistant/select/feishin_p1/repeat/config').payload);
        expect(repeat.options).toEqual(['off', 'all', 'one']);
        expect(repeat.command_topic).toBe('feishin/ha/feishin_p1/cmd/repeat');
    });
});

describe('clearDiscovery', () => {
    it('returns every discovery topic with an empty payload', () => {
        const cleared = clearDiscovery('feishin_p1');
        expect(cleared).toHaveLength(16);
        expect(cleared.every((m) => m.payload === '')).toBe(true);
        expect(cleared.map((m) => m.topic).sort()).toEqual(
            buildDiscovery('feishin_p1', 'x')
                .map((m) => m.topic)
                .sort(),
        );
    });
});
