/**
 * Public surface of the peer-sync feature. Anything other than these
 * exports is considered internal to the module.
 */
export { PeerSyncHook, usePeerSync } from '/@/renderer/features/peer-sync/hooks/use-peer-sync';
export { peerDispatcher } from '/@/renderer/features/peer-sync/controller/peer-dispatcher';
export {
    isSyncEnabled,
    pickTransport,
    recordPresence,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
export {
    isPeerClientConnected,
    publishOwnState,
    startPeerClient,
    stopPeerClient,
} from '/@/renderer/features/peer-sync/controller/peer-client';
