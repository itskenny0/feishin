package cat.kenny.feishin;

import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native bridge for the offline-cache filesystem backend (see
 * src/renderer/cache/backends/capacitor-fs-backend.ts).
 *
 * Two jobs the stock @capacitor/filesystem plugin can't do:
 *   1. Enumerate app-specific external dirs INCLUDING removable SD cards.
 *      {@code getExternalFilesDirs()} returns one dir per external volume
 *      (index 0 = the primary emulated "internal" volume, 1+ = removable
 *      cards); the stock plugin's {@code Directory.External} only ever exposes
 *      index 0. App-specific dirs need NO runtime storage permission and are
 *      auto-removed on uninstall.
 *   2. Read/write/delete files at ABSOLUTE paths under those dirs. Capacitor's
 *      Filesystem API addresses files relative to a Directory enum, so it can't
 *      target an absolute SD-card path.
 *
 * Audio/image bytes cross the bridge as base64 on write and on non-playback
 * read; PLAYBACK reads go through {@code Capacitor.convertFileSrc()} instead
 * (the local file server streams the file with range support), so the hot path
 * never calls {@link #readFile} and never materialises a track in the WebView
 * heap.
 *
 * Dependency-free (android.* + com.getcapacitor only); mirrors the
 * tiny-self-contained-plugin convention of WakeLockPlugin / TcpSocketPlugin.
 */
@CapacitorPlugin(name = "MediaVolumes")
public class MediaVolumesPlugin extends Plugin {

    private static final String TAG = "[media-volumes]";

    // Off-main-thread pool for streaming downloads. Capacitor may dispatch
    // plugin calls on a single serial thread, so we run each download on its own
    // pool thread to preserve the pipeline's download concurrency (and to keep
    // network I/O off the main thread — NetworkOnMainThreadException otherwise).
    private static final ExecutorService downloadPool = Executors.newCachedThreadPool();

    // In-flight downloads keyed by the caller's downloadId, so cancelDownload can
    // disconnect the connection and unwind the streaming copy.
    private static final ConcurrentHashMap<String, HttpURLConnection> activeDownloads =
        new ConcurrentHashMap<>();

    @PluginMethod
    public void listVolumes(PluginCall call) {
        File[] dirs = getContext().getExternalFilesDirs(null);
        JSArray volumes = new JSArray();
        if (dirs != null) {
            for (int i = 0; i < dirs.length; i++) {
                File dir = dirs[i];
                if (dir == null) continue; // unmounted volume slot
                boolean removable = i > 0;
                JSObject v = new JSObject();
                v.put("id", removable ? uuidSegment(dir.getAbsolutePath()) : "internal");
                v.put("label", removable ? "SD card" : "Internal storage");
                v.put("path", dir.getAbsolutePath());
                v.put("removable", removable);
                v.put("totalBytes", dir.getTotalSpace());
                v.put("freeBytes", dir.getUsableSpace());
                volumes.put(v);
            }
        }
        JSObject ret = new JSObject();
        ret.put("volumes", volumes);
        call.resolve(ret);
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String path = call.getString("path");
        String dataBase64 = call.getString("dataBase64");
        if (path == null || dataBase64 == null) {
            call.reject("path and dataBase64 are required");
            return;
        }
        try {
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            byte[] bytes = Base64.decode(dataBase64, Base64.NO_WRAP);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
            }
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "writeFile failed: " + e.getMessage());
            call.reject("writeFile failed: " + e.getMessage());
        }
    }

    // Stream a URL's bytes straight to a file. The bytes never enter the WebView
    // heap and are never base64-encoded/marshalled across the bridge — which is
    // what OOM-killed the app when downloading large (lossless) tracks at
    // concurrency. The download URL already embeds credentials in its query
    // string (see offline-media.ts), so a plain GET works.
    @PluginMethod
    public void downloadFile(PluginCall call) {
        final String urlStr = call.getString("url");
        final String path = call.getString("path");
        final String downloadId = call.getString("downloadId");
        if (urlStr == null || path == null || downloadId == null) {
            call.reject("url, path and downloadId are required");
            return;
        }
        downloadPool.execute(() -> runDownload(call, urlStr, path, downloadId));
    }

    private void runDownload(PluginCall call, String urlStr, String path, String downloadId) {
        File out = new File(path);
        File part = new File(path + ".part");
        HttpURLConnection conn = null;
        try {
            File parent = out.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();

            // Manual redirect loop so http↔https and relative redirects (behind a
            // reverse proxy) are followed — HttpURLConnection won't cross schemes
            // on its own.
            String current = urlStr;
            int redirects = 0;
            while (true) {
                URL u = new URL(current);
                conn = (HttpURLConnection) u.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(60000);
                conn.setRequestMethod("GET");
                activeDownloads.put(downloadId, conn);

                int code = conn.getResponseCode();
                if (code >= 300 && code < 400 && redirects < 5) {
                    String loc = conn.getHeaderField("Location");
                    activeDownloads.remove(downloadId);
                    conn.disconnect();
                    conn = null;
                    if (loc == null) throw new IOException("redirect without Location");
                    current = new URL(u, loc).toString();
                    redirects++;
                    continue;
                }
                if (code < 200 || code >= 300) {
                    throw new IOException("HTTP " + code);
                }
                break;
            }

            long total = 0;
            try (
                InputStream in = conn.getInputStream();
                FileOutputStream fos = new FileOutputStream(part)
            ) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) {
                    fos.write(buf, 0, n);
                    total += n;
                }
            }

            // Atomic-ish publish: rename the completed temp file over the final
            // path so a killed app never leaves a truncated file masquerading as
            // a complete track.
            if (out.exists()) out.delete();
            if (!part.renameTo(out)) {
                throw new IOException("rename failed");
            }

            JSObject ret = new JSObject();
            ret.put("bytes", total);
            call.resolve(ret);
        } catch (Exception e) {
            // A cancel disconnects the connection mid-read, surfacing here as an
            // IOException — reported like any other failure (the JS pipeline
            // treats an aborted/failed single download as non-fatal).
            part.delete();
            Log.w(TAG, "downloadFile failed (" + downloadId + "): " + e.getMessage());
            call.reject("downloadFile failed: " + e.getMessage());
        } finally {
            activeDownloads.remove(downloadId);
            if (conn != null) conn.disconnect();
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String downloadId = call.getString("downloadId");
        if (downloadId != null) {
            HttpURLConnection conn = activeDownloads.remove(downloadId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // best-effort — the download thread cleans up its own state
                }
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        try {
            File f = new File(path);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            }
            JSObject ret = new JSObject();
            ret.put("dataBase64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "readFile failed: " + e.getMessage());
            call.reject("readFile failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        new File(path).delete();
        call.resolve();
    }

    @PluginMethod
    public void mkdirp(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        new File(path).mkdirs();
        call.resolve();
    }

    @PluginMethod
    public void stat(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        File f = new File(path);
        JSObject ret = new JSObject();
        ret.put("exists", f.exists());
        ret.put("size", f.exists() ? f.length() : 0L);
        call.resolve(ret);
    }

    @PluginMethod
    public void freeSpace(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("path is required");
            return;
        }
        File f = new File(path);
        JSObject ret = new JSObject();
        ret.put("freeBytes", f.getUsableSpace());
        ret.put("totalBytes", f.getTotalSpace());
        call.resolve(ret);
    }

    // Extract the volume UUID (e.g. "1234-ABCD") from a removable-card path like
    // /storage/1234-ABCD/Android/data/<pkg>/files. The UUID is stable across
    // reinstalls of the same card, so it's a good volume id. Falls back to the
    // full path if the layout is unexpected.
    private String uuidSegment(String absPath) {
        String[] parts = absPath.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if (parts[i].equals("storage")) return parts[i + 1];
        }
        return absPath;
    }
}
