/**
 * Public surface of the peer-sync feature.
 *
 * Only `PeerSyncHook` is consumed via this barrel — everything else (the
 * dispatcher, the codec, the transport selector, the diagnostics store) is
 * imported deep by the few intentional cross-feature seams (the remote-
 * target lane indicators, the Connect settings page). Keeping the barrel
 * narrow makes it obvious which symbols are part of the supported surface
 * versus internal plumbing we can refactor freely.
 */
export { PeerSyncHook } from '/@/renderer/features/peer-sync/hooks/use-peer-sync';
