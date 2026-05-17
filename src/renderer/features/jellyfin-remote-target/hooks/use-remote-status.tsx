// src/renderer/features/jellyfin-remote-target/hooks/use-remote-status.tsx
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

export const useRemoteStatus = () => useRemoteTargetStore((s) => s.status);
