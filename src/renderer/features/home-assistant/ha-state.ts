// Home Assistant state payload builder + publisher.
//
// Publishes a single retained JSON snapshot to the HA state topic; every HA
// sensor/number/switch/select reads its field out of that JSON via
// value_template (see ha-discovery). Mirrors peer-sync's state-publisher
// throttle+edge pattern: position ticks are throttled (~1 Hz) while the things
// a human notices instantly (track/state/shuffle/repeat/mute change) publish on
// the leading edge.

import type { QueueSong } from '/@/shared/types/domain-types';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const log = (...a: unknown[]) => console.info('[home-assistant]', ...a);

const THROTTLE_MS = 1000;

export interface HaStatePayload {
    album: string;
    artist: string;
    duration: number;
    muted: boolean;
    position: number;
    repeat: 'all' | 'off' | 'one';
    shuffle: boolean;
    state: 'idle' | 'off' | 'paused' | 'playing';
    title: string;
    volume: number;
}

const repeatToWire = (r: PlayerRepeat): HaStatePayload['repeat'] => {
    if (r === PlayerRepeat.ALL) return 'all';
    if (r === PlayerRepeat.ONE) return 'one';
    return 'off';
};

const artistName = (current: QueueSong | undefined): string => {
    const list = current?.artists?.length ? current.artists : current?.albumArtists;
    return list?.map((a) => a.name).join(', ') ?? '';
};

export const buildHaState = (args: {
    current: QueueSong | undefined;
    muted: boolean;
    position: number;
    repeat: PlayerRepeat;
    shuffle: PlayerShuffle;
    status: PlayerStatus;
    volume: number;
}): HaStatePayload => {
    const { current } = args;
    return {
        album: current?.album ?? '',
        artist: artistName(current),
        // QueueSong.duration is milliseconds on every server backend.
        duration: current?.duration ? Math.floor(current.duration / 1000) : 0,
        muted: args.muted,
        position: Math.floor(args.position),
        repeat: repeatToWire(args.repeat),
        shuffle: args.shuffle !== PlayerShuffle.NONE,
        state: !current ? 'idle' : args.status === PlayerStatus.PLAYING ? 'playing' : 'paused',
        title: current?.name ?? '',
        volume: Math.round(args.volume),
    };
};

const snapshot = (): HaStatePayload => {
    const p = usePlayerStoreBase.getState();
    const current = p.getCurrentSong();
    return buildHaState({
        current,
        muted: p.player.muted,
        position: useTimestampStoreBase.getState().timestamp ?? 0,
        repeat: p.player.repeat,
        shuffle: p.player.shuffle,
        status: p.player.status,
        volume: p.player.volume,
    });
};

/**
 * Subscribe the player + timestamp stores and publish the JSON snapshot.
 * Returns an unsubscribe. `publish` is expected to send retained to the HA
 * state topic.
 */
export const startHaStatePublisher = (publish: (payload: string) => void): (() => void) => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let prevKey = '';

    const emit = (): void => {
        publish(JSON.stringify(snapshot()));
        last = Date.now();
    };

    const onChange = (): void => {
        const s = snapshot();
        // Edge keys: anything a human notices instantly publishes immediately.
        const key = `${s.state}|${s.title}|${s.shuffle}|${s.repeat}|${s.muted}|${s.volume}`;
        const now = Date.now();
        if (key !== prevKey) {
            prevKey = key;
            emit();
            return;
        }
        if (now - last >= THROTTLE_MS) {
            emit();
            return;
        }
        if (!timer) {
            timer = setTimeout(
                () => {
                    timer = undefined;
                    emit();
                },
                THROTTLE_MS - (now - last),
            );
        }
    };

    const unsubPlayer = usePlayerStoreBase.subscribe(onChange);
    const unsubTimestamp = useTimestampStoreBase.subscribe(onChange);
    prevKey = '';
    emit(); // initial retained snapshot
    log('state publisher started');

    return () => {
        if (timer) clearTimeout(timer);
        unsubPlayer();
        unsubTimestamp();
    };
};
