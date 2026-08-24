package com.dux.indentportal;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;
import android.view.Window;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    private static final int STORAGE_PERMISSION_REQUEST = 4107;
    private static final String PDF_DOWNLOAD_METHOD =
            "/api/method/dux_indent_master.mobile_pdf.download_mobile_pdf";

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
    private PendingDownload pendingDownload;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();
        configureBackNavigation();
        configureDownloads();
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

    /**
     * The portal creates a short-lived public HTTPS URL for every PDF request.
     * Open that URL in the device browser so Chrome/Android can download it,
     * and keep a native DownloadManager fallback for any direct WebView file.
     */
    private void configureDownloads() {
        Bridge bridge = getBridge();
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (bridge == null || webView == null) {
            return;
        }

        bridge.setWebViewClient(new PortalWebViewClient(bridge));
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                handleWebViewDownload(url, userAgent, contentDisposition, mimeType));
    }

    private boolean isPortalPdfDownload(Uri uri) {
        if (uri == null || uri.getScheme() == null || uri.getHost() == null) {
            return false;
        }

        boolean isHttps = "https".equalsIgnoreCase(uri.getScheme());
        boolean isPortalHost = "jewipl.duxdigitech.in".equalsIgnoreCase(uri.getHost());
        String path = uri.getPath();
        return isHttps && isPortalHost && path != null && path.endsWith(PDF_DOWNLOAD_METHOD);
    }

    private boolean openInExternalBrowser(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
            return true;
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "No browser is available to download the PDF.", Toast.LENGTH_LONG).show();
            return false;
        }
    }

    private boolean openIntentUrl(String url) {
        try {
            Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            intent.setSelector(null);
            startActivity(intent);
            return true;
        } catch (Exception error) {
            try {
                Intent parsedIntent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                String fallbackUrl = parsedIntent.getStringExtra("browser_fallback_url");
                if (fallbackUrl != null) {
                    Uri fallbackUri = Uri.parse(fallbackUrl);
                    if ("https".equalsIgnoreCase(fallbackUri.getScheme())) {
                        return openInExternalBrowser(fallbackUri);
                    }
                }
            } catch (Exception ignored) {
                // The original intent URL was malformed and has no safe fallback.
            }
            Toast.makeText(this, "Unable to open this link.", Toast.LENGTH_LONG).show();
            return true;
        }
    }

    private void handleWebViewDownload(
            String url,
            String userAgent,
            String contentDisposition,
            String mimeType
    ) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) {
            Toast.makeText(this, "This download link is not supported.", Toast.LENGTH_LONG).show();
            return;
        }

        PendingDownload download = new PendingDownload(url, userAgent, contentDisposition, mimeType);
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
            pendingDownload = download;
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    STORAGE_PERMISSION_REQUEST
            );
            return;
        }

        enqueueDownload(download);
    }

    private void enqueueDownload(PendingDownload download) {
        try {
            String fileName = URLUtil.guessFileName(
                    download.url,
                    download.contentDisposition,
                    download.mimeType
            );
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(download.url));
            if (download.mimeType != null && !download.mimeType.isEmpty()) {
                request.setMimeType(download.mimeType);
            }
            if (download.userAgent != null && !download.userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", download.userAgent);
            }

            String cookie = CookieManager.getInstance().getCookie(download.url);
            if (cookie != null && !cookie.isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }

            WebView webView = getBridge() == null ? null : getBridge().getWebView();
            if (webView != null && webView.getUrl() != null) {
                request.addRequestHeader("Referer", webView.getUrl());
            }

            request.setTitle(fileName);
            request.setDescription("Downloading purchase order PDF");
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            );
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager manager =
                    (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                throw new IllegalStateException("Android Download Manager is unavailable");
            }
            manager.enqueue(request);
            Toast.makeText(this, "PDF download started. Check Downloads.", Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            Toast.makeText(this, "Unable to download PDF: " + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            @NonNull String[] permissions,
            @NonNull int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != STORAGE_PERMISSION_REQUEST) {
            return;
        }

        PendingDownload download = pendingDownload;
        pendingDownload = null;
        if (download != null && grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            enqueueDownload(download);
        } else {
            Toast.makeText(this, "Storage permission is required to save the PDF.", Toast.LENGTH_LONG).show();
        }
    }

    private final class PortalWebViewClient extends BridgeWebViewClient {
        PortalWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isPortalPdfDownload(uri)) {
                return openInExternalBrowser(uri);
            }
            if ("intent".equalsIgnoreCase(uri.getScheme())) {
                return openIntentUrl(uri.toString());
            }
            return super.shouldOverrideUrlLoading(view, request);
        }

        @Deprecated
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (isPortalPdfDownload(uri)) {
                return openInExternalBrowser(uri);
            }
            if ("intent".equalsIgnoreCase(uri.getScheme())) {
                return openIntentUrl(url);
            }
            return super.shouldOverrideUrlLoading(view, url);
        }
    }

    private static final class PendingDownload {
        final String url;
        final String userAgent;
        final String contentDisposition;
        final String mimeType;

        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.contentDisposition = contentDisposition;
            this.mimeType = mimeType;
        }
    }
}
