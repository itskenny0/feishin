import {
    useFullScreenPlayerActiveTab,
    useFullScreenPlayerExpanded,
    useFullScreenPlayerVisualizerExpanded,
    usePlaybackSettings,
    useShowVisualizerInSidebar,
} from '/@/renderer/store';

export function useIsLocalVisualizerSurfaceVisible(): boolean {
    const { webAudio: webAudioEnabled } = usePlaybackSettings();
    const showVisualizerInSidebar = useShowVisualizerInSidebar();
    const activeTab = useFullScreenPlayerActiveTab();
    const expanded = useFullScreenPlayerExpanded();
    const visualizerExpanded = useFullScreenPlayerVisualizerExpanded();

    const sidebarVisualizer = showVisualizerInSidebar && webAudioEnabled;
    const fullScreenPlayerVisualizerTab = expanded && activeTab === 'visualizer' && webAudioEnabled;
    const fullScreenVisualizerOverlay = visualizerExpanded && webAudioEnabled;

    return sidebarVisualizer || fullScreenPlayerVisualizerTab || fullScreenVisualizerOverlay;
}
