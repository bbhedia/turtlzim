package org.zimnotebook.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // (what the app does for an account that a WebView does not: the requests to the account server and a place for the token; see ZimNativePlugin)
        registerPlugin(ZimNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
