/**
 * Topic-namespace helpers. The wire layout is:
 *
 *     feishin/v<PROTOCOL_VERSION>/<userId>/<peerId>/{cmd,state,presence}
 *
 * The userId is the Jellyfin user id so two Feishins logged in to different
 * accounts on the same broker stay isolated by ACL/namespace alone, even
 * before any room key is checked. The peerId is a per-install nanoid stored
 * alongside the room key so a single user with two desktops can target
 * either deliberately.
 */
import { PROTOCOL_VERSION } from '/@/renderer/features/peer-sync/types';

export type TopicLeaf = 'cmd' | 'ping' | 'pong' | 'presence' | 'state';

const ROOT = `feishin/v${PROTOCOL_VERSION}` as const;

export interface PeerAddress {
    peerId: string;
    userId: string;
}

const sanitize = (segment: string): string => segment.replace(/[\s/+#]/g, '_').slice(0, 64) || '_';

/** Build the full topic for a given peer + leaf. */
export const topicFor = (addr: PeerAddress, leaf: TopicLeaf): string =>
    `${ROOT}/${sanitize(addr.userId)}/${sanitize(addr.peerId)}/${leaf}`;

/** Build the subscription wildcard that matches every peer under a user. */
export const userPeersWildcard = (userId: string): string => `${ROOT}/${sanitize(userId)}/+/+`;

/** Build the subscription wildcard for a single peer. */
export const peerWildcard = (addr: PeerAddress): string =>
    `${ROOT}/${sanitize(addr.userId)}/${sanitize(addr.peerId)}/+`;

/**
 * Parse a topic into its parts. Returns null if the topic is not under our
 * namespace or has the wrong shape — callers MUST drop messages with null.
 */
export const parseTopic = (topic: string): null | { addr: PeerAddress; leaf: TopicLeaf } => {
    const parts = topic.split('/');
    // root has a `/` in it, so split gives us: feishin, v1, userId, peerId, leaf
    if (parts.length !== 5) return null;
    if (parts[0] !== 'feishin') return null;
    if (parts[1] !== `v${PROTOCOL_VERSION}`) return null;
    const leaf = parts[4];
    if (
        leaf !== 'cmd' &&
        leaf !== 'state' &&
        leaf !== 'presence' &&
        leaf !== 'ping' &&
        leaf !== 'pong'
    ) {
        return null;
    }
    return {
        addr: { peerId: parts[3], userId: parts[2] },
        leaf,
    };
};

export const TOPIC_ROOT = ROOT;
