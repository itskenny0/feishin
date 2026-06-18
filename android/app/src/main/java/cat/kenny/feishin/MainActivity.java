package cat.kenny.feishin;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // registerPlugin() appends to the bridgeBuilder that super.onCreate()
        // consumes when it builds the Capacitor bridge, so the plugin MUST be
        // registered before the super call or it won't be loaded.
        registerPlugin(TcpSocketPlugin.class);
        registerPlugin(WakeLockPlugin.class);
        registerPlugin(MediaVolumesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
