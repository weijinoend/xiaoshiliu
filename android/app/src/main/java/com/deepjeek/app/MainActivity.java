package com.deepjeek.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {

    private static final Set<String> HOP_BY_HOP = new HashSet<>(Arrays.asList(
        "host",
        "origin",
        "referer",
        "connection",
        "content-length",
        "transfer-encoding",
        "x-proxy-target",
        "accept-encoding",
        "cookie"
    ));

    private volatile ServerSocket proxyServer;
    private volatile int proxyPort = -1;
    private ExecutorService proxyPool;

    private volatile String updateStatus = "idle";
    private volatile int updateProgress = 0;
    private volatile long updateDownloaded = 0;
    private volatile long updateTotal = 0;
    private volatile String updateError = "";
    private volatile File downloadedApkFile = null;
    private long lastBackPressAt = 0L;
    private volatile File pendingSaveFile = null;
    private volatile String pendingSaveFileName = "";
    private ActivityResultLauncher<Intent> saveFileLauncher;

    public class ProxyBridge {
        @JavascriptInterface
        public String getProxyOrigin() {
            return proxyPort > 0 ? "http://127.0.0.1:" + proxyPort : "";
        }

        @JavascriptInterface
        public String getAppInfo() {
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
                String versionName = info.versionName != null ? info.versionName : "1.0.0";
                return "{\"isAndroid\":true,\"versionCode\":" + versionCode
                    + ",\"versionName\":\"" + escapeJson(versionName) + "\"}";
            } catch (Exception e) {
                return "{\"isAndroid\":true,\"versionCode\":1,\"versionName\":\"1.0.0\"}";
            }
        }

        @JavascriptInterface
        public void downloadAndInstallApk(String apkUrl, String fileName) {
            if ("downloading".equals(updateStatus)) {
                return;
            }
            if (apkUrl == null || !(apkUrl.startsWith("https://") || apkUrl.startsWith("http://"))) {
                updateStatus = "error";
                updateError = "Invalid APK URL";
                return;
            }
            updateStatus = "downloading";
            updateProgress = 0;
            updateDownloaded = 0;
            updateTotal = 0;
            updateError = "";
            downloadedApkFile = null;

            final String safeName = (fileName != null && !fileName.trim().isEmpty())
                ? fileName.replaceAll("[^a-zA-Z0-9._-]", "_")
                : "小石榴-update.apk";

            Thread downloadThread = new Thread(() -> {
                HttpURLConnection conn = null;
                try {
                    File updateDir = new File(getCacheDir(), "updates");
                    if (!updateDir.exists()) {
                        updateDir.mkdirs();
                    }
                    File tempFile = new File(updateDir, safeName + ".part");
                    File finalFile = new File(updateDir, safeName);

                    URL currentUrl = new URL(apkUrl);
                    int redirects = 0;
                    while (true) {
                        conn = (HttpURLConnection) currentUrl.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(60000);
                        conn.setRequestProperty("User-Agent", "XiaoShiLiu-Android");
                        int code = conn.getResponseCode();
                        if (code >= 300 && code < 400 && redirects < 8) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            if (loc == null || loc.isEmpty()) {
                                throw new IOException("Redirect without location");
                            }
                            currentUrl = new URL(currentUrl, loc);
                            redirects++;
                            continue;
                        }
                        if (code < 200 || code >= 300) {
                            throw new IOException("HTTP " + code);
                        }
                        break;
                    }

                    long total = conn.getContentLengthLong();
                    updateTotal = Math.max(0, total);
                    try (
                        InputStream in = new BufferedInputStream(conn.getInputStream());
                        FileOutputStream fileOut = new FileOutputStream(tempFile)
                    ) {
                        byte[] buf = new byte[16384];
                        long downloaded = 0;
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            fileOut.write(buf, 0, n);
                            downloaded += n;
                            updateDownloaded = downloaded;
                            if (total > 0) {
                                updateProgress = (int) Math.min(100, (downloaded * 100L) / total);
                            }
                        }
                        fileOut.flush();
                    }
                    if (finalFile.exists()) {
                        finalFile.delete();
                    }
                    if (!tempFile.renameTo(finalFile)) {
                        throw new IOException("Failed to prepare APK file");
                    }
                    downloadedApkFile = finalFile;
                    updateProgress = 100;
                    runOnUiThread(() -> triggerApkInstall(finalFile));
                } catch (Exception e) {
                    updateStatus = "error";
                    updateError = e.getMessage() != null ? e.getMessage() : "Download failed";
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
                    }, "XiaoShiLiuApkDownloader");
            downloadThread.setDaemon(true);
            downloadThread.start();
        }

        @JavascriptInterface
        public String getUpdateDownloadState() {
            return "{\"status\":\"" + escapeJson(updateStatus) + "\""
                + ",\"progress\":" + updateProgress
                + ",\"downloaded\":" + updateDownloaded
                + ",\"total\":" + updateTotal
                + ",\"error\":\"" + escapeJson(updateError) + "\""
                + ",\"hasDownloadedFile\":" + (downloadedApkFile != null && downloadedApkFile.exists())
                + "}";
        }

        @JavascriptInterface
        public void retryInstallDownloadedApk() {
            final File file = downloadedApkFile;
            if (file != null && file.exists()) {
                runOnUiThread(() -> triggerApkInstall(file));
            }
        }
    }

    private void triggerApkInstall(File apkFile) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
                updateStatus = "permission_required";
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(permIntent);
                return;
            }
            Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            updateStatus = "installing";
            startActivity(installIntent);
        } catch (Exception e) {
            updateStatus = "error";
            updateError = e.getMessage() != null ? e.getMessage() : "Install failed";
        }
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", " ")
            .replace("\n", " ");
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        saveFileLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                final File src = pendingSaveFile;
                final String name = pendingSaveFileName;
                pendingSaveFile = null;
                pendingSaveFileName = "";
                if (result.getResultCode() == Activity.RESULT_OK
                    && result.getData() != null
                    && result.getData().getData() != null
                    && src != null
                    && src.exists()) {
                    final Uri destUri = result.getData().getData();
                    new Thread(() -> {
                        try (
                            InputStream fis = new FileInputStream(src);
                            OutputStream os = getContentResolver().openOutputStream(destUri)
                        ) {
                            if (os != null) {
                                byte[] buf = new byte[16384];
                                int n;
                                while ((n = fis.read(buf)) != -1) {
                                    os.write(buf, 0, n);
                                }
                                os.flush();
                            }
                            runOnUiThread(() -> Toast.makeText(this, "已保存：" + name, Toast.LENGTH_LONG).show());
                        } catch (Exception e) {
                            runOnUiThread(() -> Toast.makeText(this, "保存失败：" + e.getMessage(), Toast.LENGTH_SHORT).show());
                        } finally {
                            //noinspection ResultOfMethodCallIgnored
                            src.delete();
                        }
                    }, "XiaoShiLiuSavePicker").start();
                } else if (src != null && src.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    src.delete();
                }
            }
        );
        startLocalProxy();
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new ProxyBridge(), "__DEEPJEEK_ANDROID_BRIDGE__");
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    handleRootBackPress();
                    return;
                }
                webView.evaluateJavascript(
                    "(function(){try{return !!(window.__deepjeekHandleAndroidBack && window.__deepjeekHandleAndroidBack());}catch(e){return false;}})()",
                    value -> {
                        if ("true".equals(value)) {
                            return;
                        }
                        if (webView.canGoBack()) {
                            webView.goBack();
                            return;
                        }
                        handleRootBackPress();
                    }
                );
            }
        });
    }

    private void handleRootBackPress() {
        long now = System.currentTimeMillis();
        if (now - lastBackPressAt <= 2000L) {
            finish();
            return;
        }
        lastBackPressAt = now;
        Toast.makeText(this, "再按一次退出小石榴", Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onDestroy() {
        stopLocalProxy();
        super.onDestroy();
    }

    private void startLocalProxy() {
        try {
            ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            proxyServer = server;
            proxyPort = server.getLocalPort();
            proxyPool = Executors.newCachedThreadPool();
            Thread acceptThread = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket client = server.accept();
                        proxyPool.submit(() -> handleClient(client));
                    } catch (IOException ignored) {
                        break;
                    }
                }
            }, "XiaoShiLiuLocalProxy");
            acceptThread.setDaemon(true);
            acceptThread.start();
        } catch (IOException ignored) {
            proxyPort = -1;
        }
    }

    private void stopLocalProxy() {
        try {
            if (proxyServer != null) {
                proxyServer.close();
            }
        } catch (IOException ignored) {
        }
        if (proxyPool != null) {
            proxyPool.shutdownNow();
        }
    }

    private void handleClient(Socket client) {
        try (Socket socket = client) {
            socket.setSoTimeout(30000);
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0].toUpperCase(Locale.ROOT) : "GET";
            String requestPath = parts.length > 1 ? parts[1] : "/";

            Map<String, String> headers = new LinkedHashMap<>();
            long contentLength = 0L;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim();
                    String value = line.substring(colon + 1).trim();
                    headers.put(name, value);
                    if ("content-length".equalsIgnoreCase(name)) {
                        try {
                            contentLength = Math.max(0L, Long.parseLong(value));
                        } catch (NumberFormatException ignored) {
                        }
                    }
                }
            }

            if ("OPTIONS".equals(method)) {
                String cors = "HTTP/1.1 204 No Content\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: *\r\n"
                    + "Access-Control-Expose-Headers: *\r\n"
                    + "Access-Control-Max-Age: 86400\r\n"
                    + "x-local-proxy: 1\r\n"
                    + "Connection: close\r\n\r\n";
                out.write(cors.getBytes(StandardCharsets.US_ASCII));
                out.flush();
                return;
            }

            if ("POST".equals(method) && requestPath.startsWith("/__deepjeek_save_file")) {
                handleSaveFileRequest(requestPath, contentLength, in, out);
                return;
            }

            int bodyLen = (int) Math.min(Integer.MAX_VALUE, contentLength);
            byte[] body = new byte[bodyLen];
            int offset = 0;
            while (offset < bodyLen) {
                int read = in.read(body, offset, bodyLen - offset);
                if (read < 0) {
                    break;
                }
                offset += read;
            }
            if (offset < bodyLen) {
                body = Arrays.copyOf(body, offset);
            }

            String targetUrl = null;
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if ("x-proxy-target".equalsIgnoreCase(entry.getKey())) {
                    targetUrl = entry.getValue();
                    break;
                }
            }
            if (targetUrl == null || !(targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
                sendJsonError(out, 400, "Missing or invalid x-proxy-target header");
                return;
            }

            HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(120000);
            conn.setRequestProperty("Accept-Encoding", "identity");

            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String keyLower = entry.getKey().toLowerCase(Locale.ROOT);
                if (!HOP_BY_HOP.contains(keyLower)) {
                    conn.setRequestProperty(entry.getKey(), entry.getValue());
                }
            }

            if (body.length > 0) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream reqOut = conn.getOutputStream()) {
                    reqOut.write(body);
                    reqOut.flush();
                }
            }

            int status = conn.getResponseCode();
            String reason = conn.getResponseMessage();
            if (reason == null || reason.isEmpty()) {
                reason = "OK";
            }

            boolean noBody = "HEAD".equals(method) || status == 204 || status == 304 || (status >= 100 && status < 200);
            StringBuilder respHeaders = new StringBuilder();
            respHeaders.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
            respHeaders.append("Access-Control-Allow-Origin: *\r\n");
            respHeaders.append("Access-Control-Expose-Headers: *\r\n");
            respHeaders.append("x-local-proxy: 1\r\n");
            respHeaders.append("Connection: close\r\n");

            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                String key = entry.getKey();
                if (key == null) {
                    continue;
                }
                String lower = key.toLowerCase(Locale.ROOT);
                if (
                    "transfer-encoding".equals(lower)
                    || "content-length".equals(lower)
                    || "content-encoding".equals(lower)
                    || "connection".equals(lower)
                    || lower.startsWith("access-control-")
                ) {
                    continue;
                }
                for (String value : entry.getValue()) {
                    respHeaders.append(key).append(": ").append(value).append("\r\n");
                }
            }
            if (!noBody) {
                respHeaders.append("Transfer-Encoding: chunked\r\n");
            }
            respHeaders.append("\r\n");
            out.write(respHeaders.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();

            if (!noBody) {
                InputStream upstream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (upstream == null && status < 400) {
                    upstream = conn.getErrorStream();
                }
                if (upstream != null) {
                    try (InputStream stream = upstream) {
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = stream.read(buf)) != -1) {
                            if (n > 0) {
                                out.write((Integer.toHexString(n) + "\r\n").getBytes(StandardCharsets.US_ASCII));
                                out.write(buf, 0, n);
                                out.write("\r\n".getBytes(StandardCharsets.US_ASCII));
                                out.flush();
                            }
                        }
                    }
                }
                out.write("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                out.flush();
            }
        } catch (Exception e) {
            try {
                sendJsonError(client.getOutputStream(), 502, e.getMessage() != null ? e.getMessage() : "Proxy failed");
            } catch (IOException ignored) {
            }
        }
    }

    private static String readLine(BufferedInputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                break;
            }
            if (b != '\r') {
                buf.write(b);
            }
        }
        if (b == -1 && buf.size() == 0) {
            return null;
        }
        return buf.toString(StandardCharsets.ISO_8859_1.name());
    }

    private void handleSaveFileRequest(
        String requestPath,
        long contentLength,
        BufferedInputStream in,
        OutputStream out
    ) throws IOException {
        String fileName = "deepjeek-export.bin";
        String mimeType = "application/octet-stream";
        int qIndex = requestPath.indexOf('?');
        if (qIndex >= 0) {
            String query = requestPath.substring(qIndex + 1);
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0) {
                    String key = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String val = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    if ("name".equals(key) && !val.trim().isEmpty()) {
                        fileName = val.trim();
                    } else if ("mime".equals(key) && !val.trim().isEmpty()) {
                        mimeType = val.trim();
                    }
                }
            }
        }
        final String safeName = fileName.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_");
        File exportDir = new File(getCacheDir(), "exports");
        if (!exportDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            exportDir.mkdirs();
        }
        File tempFile = new File(exportDir, System.currentTimeMillis() + "_" + safeName);
        byte[] buf = new byte[16384];
        long remaining = contentLength;
        try (FileOutputStream fos = new FileOutputStream(tempFile)) {
            while (remaining > 0L) {
                int toRead = (int) Math.min(buf.length, remaining);
                int read = in.read(buf, 0, toRead);
                if (read < 0) {
                    break;
                }
                fos.write(buf, 0, read);
                remaining -= read;
            }
            fos.flush();
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                ContentResolver resolver = getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/小石榴");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    try (
                        InputStream fis = new FileInputStream(tempFile);
                        OutputStream dest = resolver.openOutputStream(uri)
                    ) {
                        if (dest == null) {
                            throw new IOException("Cannot open download output stream");
                        }
                        int n;
                        while ((n = fis.read(buf)) != -1) {
                            dest.write(buf, 0, n);
                        }
                        dest.flush();
                    }
                    values.clear();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(uri, values, null, null);
                    //noinspection ResultOfMethodCallIgnored
                    tempFile.delete();
                    runOnUiThread(() ->
                        Toast.makeText(this, "已保存到「下载/小石榴/" + safeName + "」", Toast.LENGTH_LONG).show()
                    );
                    sendJsonOk(out, "{\"ok\":true,\"mode\":\"android\"}");
                    return;
                }
            } catch (Exception ignored) {
                // 回退到系统文档保存选择器
            }
        }

        if (pendingSaveFile != null && pendingSaveFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            pendingSaveFile.delete();
        }
        pendingSaveFile = tempFile;
        pendingSaveFileName = safeName;
        final String finalMime = mimeType;
        runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(finalMime);
            intent.putExtra(Intent.EXTRA_TITLE, safeName);
            saveFileLauncher.launch(intent);
        });
        sendJsonOk(out, "{\"ok\":true,\"mode\":\"picker\"}");
    }

    private static void sendJsonOk(OutputStream out, String json) throws IOException {
        byte[] payload = json.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "x-local-proxy: 1\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }

    private static void sendJsonError(OutputStream out, int status, String message) throws IOException {
        String safeMsg = message.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
        byte[] payload = ("{\"error\":{\"message\":\"" + safeMsg + "\"}}").getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " Error\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "x-local-proxy: 1\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }
}
