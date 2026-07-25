package com.dux.indentportal;

import android.graphics.Color;
import android.os.Bundle;
import android.webkit.WebView;
import android.view.Window;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String PORTAL_BACK_SCRIPT =
            "(function(){"
                    + "var wrapper=document.getElementById('page-dux-indent-portal')"
                    + "||document.querySelector('[data-page-route=\"dux-indent-portal\"]');"
                    + "var portal=wrapper&&wrapper.dux_procurement_portal;"
                    + "if(!portal||!portal.state||!portal.$root)return 'unhandled';"
                    + "if(portal.$root.hasClass('duxp-sidebar-open')){"
                    + "portal.$root.removeClass('duxp-sidebar-open');return 'handled';}"
                    + "if(portal.state.view==='form'){"
                    + "portal.close_document_form();return 'handled';}"
                    + "if(portal.state.view==='detail'){"
                    + "portal.open_document_list(portal.state.route_key);return 'handled';}"
                    + "if(portal.state.view!=='dashboard'){"
                    + "portal.open_dashboard();return 'handled';}"
                    + "return 'unhandled';"
                    + "})()";

    private boolean backNavigationInProgress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();
        configureBackNavigation();
    }

    @Override
    public void onResume() {
        super.onResume();
        configureSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            configureSystemBars();
        }
    }

    /**
     * The portal is a remote Frappe page and cannot reliably consume native
     * Android window insets. Keep the Capacitor WebView inside the status and
     * navigation bars so its header and bottom controls remain fully visible.
     */
    private void configureSystemBars() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, true);
        window.setStatusBarColor(Color.WHITE);
        window.setNavigationBarColor(Color.WHITE);

        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
        controller.show(WindowInsetsCompat.Type.systemBars());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);
    }

    /**
     * Android's default back action finishes a Capacitor BridgeActivity. Route
     * it through the live portal's WebView first so one press returns to the
     * previous portal screen. Only leave the app when no web history exists.
     */
    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView == null) {
                    finish();
                    return;
                }

                if (backNavigationInProgress) {
                    return;
                }

                backNavigationInProgress = true;
                webView.evaluateJavascript(PORTAL_BACK_SCRIPT, result -> {
                    backNavigationInProgress = false;
                    if ("\"handled\"".equals(result)) {
                        return;
                    }
                    if (webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        finish();
                    }
                });
            }
        });
    }
}
