// Tier-2 helper: a copy-paste `media_player_template` (HACS "media_player.template"
// by Sennevds) config that composes the autodiscovered Tier-1 entities into a
// single native media-player card. Optional — Tier-1 already gives full control
// via the discovered device; this is for users who want the unified card.
//
// HA derives entity_ids from the device's friendly name (slugified), so the
// snippet is parameterised by the device name. If the user later renames the
// device in HA, they must adjust the entity_ids accordingly (noted in-snippet).

const slug = (name: string): string =>
    (name || 'Feishin')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'feishin';

export const haTemplateSnippet = (deviceName: string): string => {
    const s = slug(deviceName);
    const name = deviceName || 'Feishin';
    return `# Optional: a unified media-player card for "${name}".
# Requires the HACS "media_player.template" (Sennevds) custom component.
# Feishin's autodiscovered entities already give full control without this.
# Entity ids below are derived from the device name; if you rename the device
# in Home Assistant, update the "${s}_" prefixes to match.
media_player:
  - platform: media_player_template
    media_players:
      ${s}:
        friendly_name: "${name}"
        device_class: speaker
        value_template: "{{ states('sensor.${s}_state') }}"
        title_template: "{{ states('sensor.${s}_title') }}"
        artist_template: "{{ states('sensor.${s}_artist') }}"
        album_template: "{{ states('sensor.${s}_album') }}"
        current_position_template: "{{ states('sensor.${s}_position') | int(0) }}"
        media_duration_template: "{{ states('sensor.${s}_duration') | int(0) }}"
        media_image_url_template: "{{ state_attr('image.${s}_artwork', 'entity_picture') }}"
        current_volume_template: "{{ states('number.${s}_volume') | int(0) }}"
        current_is_muted_template: "{{ is_state('switch.${s}_mute', 'on') }}"
        play:
          service: button.press
          target: { entity_id: button.${s}_play }
        pause:
          service: button.press
          target: { entity_id: button.${s}_pause }
        stop:
          service: button.press
          target: { entity_id: button.${s}_stop }
        next:
          service: button.press
          target: { entity_id: button.${s}_next }
        previous:
          service: button.press
          target: { entity_id: button.${s}_previous }
        set_volume:
          service: number.set_value
          target: { entity_id: number.${s}_volume }
          data: { value: "{{ (volume * 100) | int }}" }
        mute:
          service: switch.turn_{{ 'on' if is_muted else 'off' }}
          target: { entity_id: switch.${s}_mute }
`;
};
