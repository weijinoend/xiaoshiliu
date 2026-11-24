package com.deepjeek.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
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
import androidx.core.content.ContextCompat;
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
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {

    private static final int MAX_LINE_BYTES = 16 * 1024;
    private static final int MAX_HEADERS = 128;
    private static final int MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;
    private static final long MAX_SAVE_FILE_BYTES = 256L * 1024 * 1024;
    private static final String STATE_PENDING_SAVE_FILE = "pending_save_file";
    private static final String STATE_PENDING_SAVE_NAME = "pending_save_name";

    private static final Set<String> HOP_BY_HOP = new HashSet<>(Arrays.asList(
        "host",
        "origin",
        "referer",
        "connection",
        "content-length",
        "transfer-encoding",
        "x-proxy-target",
        "x-proxy-token",
        "accept-encoding",
        "cookie"
    ));

    private final String proxyToken = generateToken();
    private final AtomicBoolean updateDownloading = new AtomicBoolean(false);
    private final Map<String, File> capturedPhotos = new ConcurrentHashMap<>();

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
    private volatile File pendingCameraFile = null;
    private ActivityResultLauncher<Intent> saveFileLauncher;
    private ActivityResultLauncher<Intent> cameraCaptureLauncher;
    private ActivityResultLauncher<String> cameraPermissionLauncher;

    private static String generateToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >>> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    private static boolean isZhLocale() {
        return Locale.getDefault().getLanguage().toLowerCase(Locale.ROOT).startsWith("zh");
    }

    private static boolean isAllowedApkUrl(URL url) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) {
            return false;
        }
        String host = url.getHost();
        if (host == null) {
            return false;
        }
        String lower = host.toLowerCase(Locale.ROOT);
        return "github.com".equals(lower)
            || "objects.githubusercontent.com".equals(lower)
            || lower.endsWith(".githubusercontent.com");
    }

    private static String sanitizeApkName(String fileName) {
        if (fileName == null || fileName.trim().isEmpty()) {
            return "XiaoShiLiu-update.apk";
        }
        String cleaned = fileName.trim().replaceAll("[^a-zA-Z0-9._-]", "_").replaceAll("^\\.+", "");
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "XiaoShiLiu-update.apk";
        }
        return cleaned;
    }

    public class ProxyBridge {
        @JavascriptInterface
        public String getProxyOrigin() {
            return proxyPort > 0 ? "http://127.0.0.1:" + proxyPort : "";
        }

        @JavascriptInterface
        public String getProxyToken() {
            return proxyToken;
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
        public boolean capturePhoto() {
            if (isFinishing() || isDestroyed()) {
                return false;
            }
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
                    }
                });
                return true;
            }
            return launchNativeCamera();
        }

        @JavascriptInterface
        public void downloadAndInstallApk(String apkUrl, String fileName) {
            if (!updateDownloading.compareAndSet(false, true)) {
                return;
            }
            URL initialUrl;
            try {
                initialUrl = new URL(apkUrl);
            } catch (Exception e) {
                updateStatus = "error";
                updateError = "Invalid APK URL";
                updateDownloading.set(false);
                return;
            }
            if (!isAllowedApkUrl(initialUrl)) {
                updateStatus = "error";
                updateError = "Untrusted APK URL";
                updateDownloading.set(false);
                return;
            }
            updateStatus = "downloading";
            updateProgress = 0;
            updateDownloaded = 0;
            updateTotal = 0;
            updateError = "";
            downloadedApkFile = null;

            final String safeName = sanitizeApkName(fileName);

            Thread downloadThread = new Thread(() -> {
                HttpURLConnection conn = null;
                File tempFile = null;
                try {
                    File updateDir = new File(getCacheDir(), "updates");
                    if (!updateDir.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        updateDir.mkdirs();
                    }
                    File[] oldFiles = updateDir.listFiles();
                    if (oldFiles != null) {
                        for (File old : oldFiles) {
                            if (!old.getName().equals(safeName)) {
                                //noinspection ResultOfMethodCallIgnored
                                old.delete();
                            }
                        }
                    }
                    tempFile = new File(updateDir, safeName + ".part");
                    File finalFile = new File(updateDir, safeName);

                    URL currentUrl = initialUrl;
                    int redirects = 0;
                    while (true) {
                        if (!isAllowedApkUrl(currentUrl)) {
                            throw new IOException("Untrusted APK redirect URL");
                        }
                        conn = (HttpURLConnection) currentUrl.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(60000);
                        conn.setRequestProperty("User-Agent", "XiaoShiLiu-Android");
                        int code = conn.getResponseCode();
                        if (code >= 300 && code < 400 && redirects < 8) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            conn = null;
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
                        //noinspection ResultOfMethodCallIgnored
                        finalFile.delete();
                    }
                    if (!tempFile.renameTo(finalFile)) {
                        throw new IOException("Failed to prepare APK file");
                    }
                    tempFile = null;
                    downloadedApkFile = finalFile;
                    updateProgress = 100;
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed()) {
                            triggerApkInstall(finalFile);
                        }
                    });
                } catch (Exception e) {
                    if (tempFile != null && tempFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        tempFile.delete();
                    }
                    updateStatus = "error";
                    updateError = e.getMessage() != null ? e.getMessage() : "Download failed";
                } finally {
                    updateDownloading.set(false);
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
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        triggerApkInstall(file);
                    }
                });
            }
        }
    }

    private boolean launchNativeCamera() {
        try {
            File picturesDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            if (picturesDir == null) {
                picturesDir = new File(getCacheDir(), "Pictures");
            }
            if (!picturesDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                picturesDir.mkdirs();
            }
            File photoFile = File.createTempFile("IMG_" + System.currentTimeMillis() + "_", ".jpg", picturesDir);
            Uri photoUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photoFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            pendingCameraFile = photoFile;
            runOnUiThread(() -> {
                try {
                    if (!isFinishing() && !isDestroyed()) {
                        cameraCaptureLauncher.launch(intent);
                    }
                } catch (ActivityNotFoundException e) {
                    if (pendingCameraFile != null && pendingCameraFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        pendingCameraFile.delete();
                    }
                    pendingCameraFile = null;
                    Toast.makeText(
                        this,
                        isZhLocale() ? "未找到可用相机应用" : "No camera app found",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            });
            return true;
        } catch (Exception e) {
            if (pendingCameraFile != null && pendingCameraFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                pendingCameraFile.delete();
            }
            pendingCameraFile = null;
            return false;
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

    private static String stripCrLf(String value) {
        return value == null ? "" : value.replace("\r", "").replace("\n", " ");
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        File pending = pendingSaveFile;
        if (pending != null) {
            outState.putString(STATE_PENDING_SAVE_FILE, pending.getAbsolutePath());
            outState.putString(STATE_PENDING_SAVE_NAME, pendingSaveFileName);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null) {
            String path = savedInstanceState.getString(STATE_PENDING_SAVE_FILE);
            if (path != null) {
                pendingSaveFile = new File(path);
                pendingSaveFileName = savedInstanceState.getString(STATE_PENDING_SAVE_NAME, "");
            }
        }
        cameraPermissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            granted -> {
                if (granted) {
                    launchNativeCamera();
                } else {
                    Toast.makeText(
                        this,
                        isZhLocale() ? "未授予相机权限，请在系统设置中开启" : "Camera permission denied",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            }
        );
        cameraCaptureLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                final File photoFile = pendingCameraFile;
                pendingCameraFile = null;
                if (result.getResultCode() == Activity.RESULT_OK && photoFile != null && photoFile.exists() && photoFile.length() > 0) {
                    String id = UUID.randomUUID().toString();
                    capturedPhotos.put(id, photoFile);
                    WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                    if (webView != null && !isFinishing() && !isDestroyed()) {
                        String js = "window.__deepjeekOnNativePhoto && window.__deepjeekOnNativePhoto(\""
                            + escapeJson(id) + "\",\"" + escapeJson(photoFile.getName()) + "\");";
                        webView.evaluateJavascript(js, null);
                    }
                } else if (photoFile != null && photoFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    photoFile.delete();
                }
            }
        );
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
                            runOnUiThread(() -> {
                                if (!isFinishing() && !isDestroyed()) {
                                    String msg = isZhLocale() ? "已保存：" + name : "Saved: " + name;
                                    Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                                }
                            });
                        } catch (Exception e) {
                            runOnUiThread(() -> {
                                if (!isFinishing() && !isDestroyed()) {
                                    String msg = isZhLocale() ? "保存失败：" + e.getMessage() : "Save failed: " + e.getMessage();
                                    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
                                }
                            });
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
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
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
                        if (isFinishing() || isDestroyed()) {
                            return;
                        }
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
        Toast.makeText(
            this,
            isZhLocale() ? "再按一次退出小石榴" : "Press back again to exit Little Pomegranate",
            Toast.LENGTH_SHORT
        ).show();
    }

    @Override
    public void onDestroy() {
        stopLocalProxy();
        for (File photo : capturedPhotos.values()) {
            if (photo != null && photo.exists()) {
                //noinspection ResultOfMethodCallIgnored
                photo.delete();
            }
        }
        capturedPhotos.clear();
        if (pendingCameraFile != null && pendingCameraFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            pendingCameraFile.delete();
            pendingCameraFile = null;
        }
        super.onDestroy();
    }

    private void startLocalProxy() {
        try {
            ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            proxyServer = server;
            proxyPort = server.getLocalPort();
            proxyPool = Executors.newFixedThreadPool(16);
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

    private static String resolveAllowedOrigin(Map<String, List<String>> headers) {
        List<String> origins = headers.get("origin");
        if (origins == null || origins.isEmpty()) {
            return "https://localhost";
        }
        String origin = origins.get(0);
        if (origin == null) {
            return null;
        }
        String lower = origin.trim().toLowerCase(Locale.ROOT);
        if ("https://localhost".equals(lower)
            || "http://localhost".equals(lower)
            || "capacitor://localhost".equals(lower)
            || lower.startsWith("http://127.0.0.1:")
            || "http://127.0.0.1".equals(lower)) {
            return stripCrLf(origin.trim());
        }
        return null;
    }

    private boolean isAuthorizedToken(Map<String, List<String>> headers) {
        List<String> tokens = headers.get("x-proxy-token");
        if (tokens == null || tokens.isEmpty()) {
            return false;
        }
        String supplied = tokens.get(0);
        if (supplied == null) {
            return false;
        }
        return MessageDigest.isEqual(
            supplied.getBytes(StandardCharsets.UTF_8),
            proxyToken.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static byte[] readChunkedBody(BufferedInputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            String sizeLine = readLine(in);
            if (sizeLine == null) {
                break;
            }
            int semi = sizeLine.indexOf(';');
            String hex = (semi >= 0 ? sizeLine.substring(0, semi) : sizeLine).trim();
            if (hex.isEmpty()) {
                continue;
            }
            int chunkSize = Integer.parseInt(hex, 16);
            if (chunkSize == 0) {
                String trailer;
                while ((trailer = readLine(in)) != null && !trailer.isEmpty()) {
                    // consume trailers
                }
                break;
            }
            if (out.size() + chunkSize > maxBytes) {
                throw new IOException("Request body too large");
            }
            byte[] buf = new byte[Math.min(16384, chunkSize)];
            int remaining = chunkSize;
            while (remaining > 0) {
                int r = in.read(buf, 0, Math.min(buf.length, remaining));
                if (r < 0) {
                    throw new IOException("Unexpected EOF in chunked body");
                }
                out.write(buf, 0, r);
                remaining -= r;
            }
            readLine(in); // CRLF after chunk
        }
        return out.toByteArray();
    }

    private void handleClient(Socket client) {
        boolean headersSent = false;
        String corsOrigin = "https://localhost";
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

            Map<String, List<String>> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
            long contentLength = 0L;
            boolean isChunked = false;
            int headerCount = 0;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                if (++headerCount > MAX_HEADERS) {
                    sendJsonError(out, 431, "Too many headers", corsOrigin);
                    return;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim();
                    String value = line.substring(colon + 1).trim();
                    headers.computeIfAbsent(name, k -> new ArrayList<>()).add(value);
                    if ("content-length".equalsIgnoreCase(name)) {
                        try {
                            contentLength = Math.max(0L, Long.parseLong(value));
                        } catch (NumberFormatException ignored) {
                        }
                    } else if ("transfer-encoding".equalsIgnoreCase(name)
                        && value.toLowerCase(Locale.ROOT).contains("chunked")) {
                        isChunked = true;
                    }
                }
            }

            String matchedOrigin = resolveAllowedOrigin(headers);
            if (matchedOrigin == null) {
                sendJsonError(out, 403, "Forbidden origin", "https://localhost");
                return;
            }
            corsOrigin = matchedOrigin;

            if ("OPTIONS".equals(method)) {
                String cors = "HTTP/1.1 204 No Content\r\n"
                    + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
                    + "Vary: Origin\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: *\r\n"
                    + "Access-Control-Expose-Headers: *\r\n"
                    + "Access-Control-Max-Age: 86400\r\n"
                    + "x-local-proxy: 1\r\n"
                    + "Connection: close\r\n\r\n";
                out.write(cors.getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                return;
            }

            if (!isAuthorizedToken(headers)) {
                sendJsonError(out, 403, "Invalid proxy token", corsOrigin);
                return;
            }

            if ("GET".equals(method) && requestPath.startsWith("/__deepjeek_captured_photo")) {
                handleCapturedPhotoRequest(requestPath, out, corsOrigin);
                return;
            }

            if ("POST".equals(method) && requestPath.startsWith("/__deepjeek_save_file")) {
                if (contentLength > MAX_SAVE_FILE_BYTES) {
                    sendJsonError(out, 413, "File too large", corsOrigin);
                    return;
                }
                handleSaveFileRequest(requestPath, contentLength, in, out, corsOrigin);
                return;
            }

            byte[] body;
            if (isChunked) {
                body = readChunkedBody(in, MAX_PROXY_BODY_BYTES);
            } else {
                if (contentLength > MAX_PROXY_BODY_BYTES) {
                    sendJsonError(out, 413, "Request body too large", corsOrigin);
                    return;
                }
                int bodyLen = (int) contentLength;
                body = new byte[bodyLen];
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
            }

            List<String> targets = headers.get("x-proxy-target");
            String targetUrlStr = (targets != null && !targets.isEmpty()) ? targets.get(0) : null;
            if (targetUrlStr == null || !(targetUrlStr.startsWith("http://") || targetUrlStr.startsWith("https://"))) {
                sendJsonError(out, 400, "Missing or invalid x-proxy-target header", corsOrigin);
                return;
            }

            URL currentUrl = new URL(targetUrlStr);
            HttpURLConnection conn = null;
            try {
                int redirects = 0;
                String activeMethod = method;
                byte[] activeBody = body;
                while (true) {
                    conn = (HttpURLConnection) currentUrl.openConnection();
                    conn.setRequestMethod(activeMethod);
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(120000);
                    conn.setRequestProperty("Accept-Encoding", "identity");

                    boolean crossHost = !currentUrl.getHost().equalsIgnoreCase(new URL(targetUrlStr).getHost());
                    for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
                        String keyLower = entry.getKey().toLowerCase(Locale.ROOT);
                        if (HOP_BY_HOP.contains(keyLower)) {
                            continue;
                        }
                        if (crossHost && "authorization".equals(keyLower)) {
                            continue;
                        }
                        for (String val : entry.getValue()) {
                            conn.addRequestProperty(entry.getKey(), val);
                        }
                    }

                    if (activeBody.length > 0 && !"GET".equals(activeMethod) && !"HEAD".equals(activeMethod)) {
                        conn.setDoOutput(true);
                        conn.setFixedLengthStreamingMode(activeBody.length);
                        try (OutputStream reqOut = conn.getOutputStream()) {
                            reqOut.write(activeBody);
                            reqOut.flush();
                        }
                    }

                    int code = conn.getResponseCode();
                    if ((code == 301 || code == 302 || code == 303 || code == 307 || code == 308) && redirects < 6) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (loc == null || loc.isEmpty()) {
                            break;
                        }
                        URL nextUrl = new URL(currentUrl, loc);
                        if (!("http".equalsIgnoreCase(nextUrl.getProtocol()) || "https".equalsIgnoreCase(nextUrl.getProtocol()))) {
                            throw new IOException("Unsupported redirect protocol");
                        }
                        if (code == 303 || ((code == 301 || code == 302) && "POST".equals(activeMethod))) {
                            activeMethod = "GET";
                            activeBody = new byte[0];
                        }
                        currentUrl = nextUrl;
                        redirects++;
                        continue;
                    }
                    break;
                }

                if (conn == null) {
                    sendJsonError(out, 502, "Invalid upstream redirect", corsOrigin);
                    return;
                }

                int status = conn.getResponseCode();
                String reason = stripCrLf(conn.getResponseMessage());
                if (reason.isEmpty()) {
                    reason = "OK";
                }

                boolean noBody = "HEAD".equals(activeMethod) || status == 204 || status == 304 || (status >= 100 && status < 200);
                StringBuilder respHeaders = new StringBuilder();
                respHeaders.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
                respHeaders.append("Access-Control-Allow-Origin: ").append(corsOrigin).append("\r\n");
                respHeaders.append("Vary: Origin\r\n");
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
                        || "vary".equals(lower)
                        || lower.startsWith("access-control-")
                    ) {
                        continue;
                    }
                    String safeKey = stripCrLf(key);
                    for (String value : entry.getValue()) {
                        respHeaders.append(safeKey).append(": ").append(stripCrLf(value)).append("\r\n");
                    }
                }
                if (!noBody) {
                    respHeaders.append("Transfer-Encoding: chunked\r\n");
                }
                respHeaders.append("\r\n");
                out.write(respHeaders.toString().getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                headersSent = true;

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
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        } catch (Exception e) {
            if (!headersSent) {
                try {
                    sendJsonError(
                        client.getOutputStream(),
                        502,
                        e.getMessage() != null ? e.getMessage() : "Proxy failed",
                        corsOrigin
                    );
                } catch (IOException ignored) {
                }
            }
        }
    }

    private void handleCapturedPhotoRequest(String requestPath, OutputStream out, String corsOrigin) throws IOException {
        String id = null;
        int qIndex = requestPath.indexOf('?');
        if (qIndex >= 0) {
            String query = requestPath.substring(qIndex + 1);
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0 && "id".equals(URLDecoder.decode(pair.substring(0, eq), "UTF-8"))) {
                    id = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    break;
                }
            }
        }
        File file = id != null ? capturedPhotos.remove(id) : null;
        if (file == null || !file.exists()) {
            sendJsonError(out, 404, "Photo not found", corsOrigin);
            return;
        }
        try {
            long len = file.length();
            String header = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: image/jpeg\r\n"
                + "Content-Length: " + len + "\r\n"
                + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
                + "Vary: Origin\r\n"
                + "Access-Control-Expose-Headers: *\r\n"
                + "x-local-proxy: 1\r\n"
                + "Connection: close\r\n\r\n";
            out.write(header.getBytes(StandardCharsets.ISO_8859_1));
            try (FileInputStream fis = new FileInputStream(file)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = fis.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
            out.flush();
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
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
                if (buf.size() >= MAX_LINE_BYTES) {
                    throw new IOException("HTTP header line too long");
                }
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
        OutputStream out,
        String corsOrigin
    ) throws IOException {
        String fileName = "xiaoshiliu-export.bin";
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
            Uri insertedUri = null;
            ContentResolver resolver = getContentResolver();
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/小石榴");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                insertedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (insertedUri != null) {
                    try (
                        InputStream fis = new FileInputStream(tempFile);
                        OutputStream dest = resolver.openOutputStream(insertedUri)
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
                    resolver.update(insertedUri, values, null, null);
                    //noinspection ResultOfMethodCallIgnored
                    tempFile.delete();
                    runOnUiThread(() -> {
                        if (!isFinishing() && !isDestroyed()) {
                            String msg = isZhLocale()
                                ? "已保存到「下载/小石榴/" + safeName + "」"
                                : "Saved to Download/Little Pomegranate/" + safeName;
                            Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                        }
                    });
                    sendJsonOk(out, "{\"ok\":true,\"mode\":\"android\"}", corsOrigin);
                    return;
                }
            } catch (Exception ignored) {
                if (insertedUri != null) {
                    try {
                        resolver.delete(insertedUri, null, null);
                    } catch (Exception deleteIgnored) {
                        // ignore cleanup failure
                    }
                }
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
            if (!isFinishing() && !isDestroyed()) {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(finalMime);
                intent.putExtra(Intent.EXTRA_TITLE, safeName);
                saveFileLauncher.launch(intent);
            }
        });
        sendJsonOk(out, "{\"ok\":true,\"mode\":\"picker\"}", corsOrigin);
    }

    private static void sendJsonOk(OutputStream out, String json, String corsOrigin) throws IOException {
        byte[] payload = json.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
            + "Vary: Origin\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "x-local-proxy: 1\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }

    private static void sendJsonError(OutputStream out, int status, String message, String corsOrigin) throws IOException {
        String safeMsg = escapeJson(message != null ? message : "Error");
        byte[] payload = ("{\"error\":{\"message\":\"" + safeMsg + "\"}}").getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " Error\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Access-Control-Allow-Origin: " + corsOrigin + "\r\n"
            + "Vary: Origin\r\n"
            + "Access-Control-Expose-Headers: *\r\n"
            + "x-local-proxy: 1\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(payload);
        out.flush();
    }
}
