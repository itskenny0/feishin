import { ipcRenderer } from 'electron';

export interface PreloadPeerBrokerConfig {
    host: string;
    port: number;
    roomKey: string;
    tlsCertPath?: string;
    tlsKeyPath?: string;
}

/**
 * Bridge for the main-process embedded MQTT broker. The renderer calls
 * `setEnabled(config)` to start it and `setEnabled(null)` to stop it.
 * Both return `null` on success or an error message string on failure
 * (matching the existing `remote-*` IPC channel shape).
 */
const setEnabled = (config: null | PreloadPeerBrokerConfig): Promise<null | string> =>
    ipcRenderer.invoke('peer-broker-enable', config);

const status = (): Promise<boolean> => ipcRenderer.invoke('peer-broker-status');

export const peerBroker = {
    setEnabled,
    status,
};

export type PeerBrokerBridge = typeof peerBroker;
