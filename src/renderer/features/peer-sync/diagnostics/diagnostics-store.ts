import type {
    PeerCommand,
    PeerPresence,
    PeerState,
    TransportKind,
} from '/@/renderer/features/peer-sync/types';

/**
 * In-memory diagnostics for the peer-sync subsystem. Drives the
 * Settings -> Connect -> Diagnostics subpage and any inline status
 * indicators (the playerbar lane pill, the device-picker badges, etc.).
 *
 * Everything here is ephemeral: not persisted, reset on a hot reload, and
 * derived from events that already flow through the existing
 * `use-peer-sync` hook + `transport-selector`. Recording is a no-op when
 * peer sync is disabled.
 */
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

const RING_SIZE = 50;

export type BrokerConnectionStatus =
    | 'connected'
    | 'connecting'
    | 'disconnected'
    | 'errored'
    | 'idle';

export interface BrokerStatus {
    /** Most recent reported MQTT client status. */
    clientStatus: BrokerConnectionStatus;
    /** Last error message from the client, if any. */
    lastErrorMessage?: string;
    /** Wall-clock ts of the last state change. */
    lastTransitionAt?: number;
}

export type CommandDirection = 'inbound' | 'outbound';

export interface CommandEntry {
    direction: CommandDirection;
    k: string;
    peerId: string;
    /** Monotonic timestamp (Date.now()). */
    ts: number;
}

export interface EmbeddedBrokerStatus {
    enabled: boolean;
    listenAddress?: string;
    running: boolean;
}

export interface LatencySample {
    /** RTT in milliseconds. */
    rttMs: number;
    ts: number;
}

export interface PresenceEntry {
    lastSeenAt: number;
    online: boolean;
    peerId: string;
}

export interface StateEntry {
    direction: 'inbound' | 'outbound';
    paused: boolean;
    peerId: string;
    pos: number;
    trackTitle?: null | string;
    ts: number;
}

export interface TransportFlipEntry {
    from: TransportKind;
    peerId: string;
    to: TransportKind;
    ts: number;
}

interface DiagnosticsState {
    broker: BrokerStatus;
    commands: CommandEntry[];
    embeddedBroker: EmbeddedBrokerStatus;
    flips: TransportFlipEntry[];
    /** Newest latency samples keyed by peerId (one per peer, most recent). */
    latency: Record<string, LatencySample>;
    presence: Record<string, PresenceEntry>;
    states: StateEntry[];
}

const initial: DiagnosticsState = {
    broker: { clientStatus: 'idle' },
    commands: [],
    embeddedBroker: { enabled: false, running: false },
    flips: [],
    latency: {},
    presence: {},
    states: [],
};

const useDiagnosticsStoreInternal = create<DiagnosticsState>(() => initial);

const push = <T>(arr: T[], next: T): T[] => {
    const out = arr.length >= RING_SIZE ? arr.slice(arr.length - RING_SIZE + 1) : arr.slice();
    out.push(next);
    return out;
};

export const recordBrokerStatus = (status: BrokerConnectionStatus, errorMessage?: string): void => {
    useDiagnosticsStoreInternal.setState((s) => {
        if (s.broker.clientStatus === status && s.broker.lastErrorMessage === errorMessage) {
            return s;
        }
        return {
            ...s,
            broker: {
                clientStatus: status,
                lastErrorMessage: errorMessage,
                lastTransitionAt: Date.now(),
            },
        };
    });
};

export const recordEmbeddedBroker = (status: EmbeddedBrokerStatus): void => {
    useDiagnosticsStoreInternal.setState((s) => ({ ...s, embeddedBroker: status }));
};

export const recordOutboundCommand = (peerId: string, command: PeerCommand): void => {
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        commands: push(s.commands, {
            direction: 'outbound',
            k: command.k,
            peerId,
            ts: command.ts ?? Date.now(),
        }),
    }));
};

export const recordInboundCommand = (peerId: string, command: PeerCommand): void => {
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        commands: push(s.commands, {
            direction: 'inbound',
            k: command.k,
            peerId,
            ts: command.ts ?? Date.now(),
        }),
    }));
};

export const recordOutboundState = (peerId: string, state: PeerState): void => {
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        states: push(s.states, {
            direction: 'outbound',
            paused: state.paused,
            peerId,
            pos: state.pos,
            trackTitle: state.track?.title,
            ts: state.ts ?? Date.now(),
        }),
    }));
};

export const recordInboundState = (peerId: string, state: PeerState): void => {
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        states: push(s.states, {
            direction: 'inbound',
            paused: state.paused,
            peerId,
            pos: state.pos,
            trackTitle: state.track?.title,
            ts: state.ts ?? Date.now(),
        }),
    }));
};

export const recordPresenceFrame = (peerId: string, presence: PeerPresence): void => {
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        presence: {
            ...s.presence,
            [peerId]: { lastSeenAt: presence.ts ?? Date.now(), online: presence.online, peerId },
        },
    }));
};

export const recordTransportFlip = (
    peerId: string,
    from: TransportKind,
    to: TransportKind,
): void => {
    if (from === to) return;
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        flips: push(s.flips, { from, peerId, to, ts: Date.now() }),
    }));
};

export const recordLatencySample = (peerId: string, rttMs: number): void => {
    useDiagnosticsStoreInternal.setState((s) => ({
        ...s,
        latency: { ...s.latency, [peerId]: { rttMs, ts: Date.now() } },
    }));
};

export const resetDiagnostics = (): void => useDiagnosticsStoreInternal.setState(initial, true);

const subscribe = useDiagnosticsStoreInternal.subscribe;
const getState = useDiagnosticsStoreInternal.getState;

export const useDiagnostics = <T>(selector: (s: DiagnosticsState) => T): T =>
    useSyncExternalStore(
        subscribe,
        () => selector(getState()),
        () => selector(initial),
    );

export const peekDiagnostics = (): DiagnosticsState => getState();
