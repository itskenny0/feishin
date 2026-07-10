// Public API for the offline-download subsystem. UI + lifecycle import from
// here rather than reaching into the manager directly.

import type { AddTargetArgs } from './manager';

import { offlineManager } from './manager';

export type { AddTargetArgs } from './manager';
export { offlineManager } from './manager';

export const enqueueOffline = (a: AddTargetArgs) => offlineManager.enqueue(a);
export const enqueueOfflineMany = (a: AddTargetArgs[]) => offlineManager.enqueueMany(a);
export const pauseAllOffline = () => offlineManager.pauseAll();
export const pauseOffline = (key: string) => offlineManager.pause(key);
export const removeAllOffline = () => offlineManager.removeAll();
export const removeOffline = (key: string) => offlineManager.remove(key);
export const resumeAllOffline = () => offlineManager.resumeAll();
export const resumeOffline = (key: string) => offlineManager.resume(key);
export const resumePersistedOffline = () => offlineManager.resumePersisted();
export const retryOffline = (key: string) => offlineManager.retry(key);
export const syncAllOffline = () => offlineManager.syncAll();
export const syncNowOffline = (key: string) => offlineManager.syncNow(key);
