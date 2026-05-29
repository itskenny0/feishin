package cat.kenny.feishin;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.cert.X509Certificate;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Self-contained raw-TCP socket plugin for the MQTT peer-sync transport.
 *
 * Standard MQTT brokers expose raw TCP on 1883 (8883 for TLS) and frequently
 * have no WebSocket listener at all, so the WebSocket-only mqtt.js transport
 * cannot reach them from the Android WebView. This plugin opens a plain
 * {@link java.net.Socket} (or {@link javax.net.ssl.SSLSocket} for TLS) on a
 * worker thread and bridges bytes to/from JS as base64 strings. The JS side
 * (native-tcp-stream.ts) wraps it in a Duplex that mqtt.js drives directly, so
 * ALL the MQTT protocol logic (LWT, retained, QoS, reconnect) stays in mqtt.js
 * untouched — only the transport bytes change.
 *
 * Pure java.net.* / javax.net.ssl.* / android.util.Base64 / com.getcapacitor
 * APIs only — no external maven dependency.
 *
 * Method surface (all return immediately; results delivered via resolve/events):
 *   - open({ id, host, port, tls?, rejectUnauthorized? })  -> resolves once the
 *     socket is connected; a connect failure rejects AND emits an `error`
 *     event so the JS Duplex can surface it to mqtt.js the same way a refused
 *     WebSocket does (mqtt.js then retries on its own schedule).
 *   - write({ id, data })   data is base64 of the raw bytes to send.
 *   - close({ id })         tears the socket down; idempotent.
 *
 * Events (notifyListeners), each carrying { id, ... }:
 *   - data   { id, data }     base64 of bytes read from the socket.
 *   - close  { id }           the socket reached EOF or was closed.
 *   - error  { id, message }  a connect/read/write error occurred.
 *
 * The `id` namespaces concurrent sockets so a future multi-broker setup (or a
 * reconnect that opens a fresh socket before the old one finishes tearing
 * down) cannot cross its streams. mqtt.js only ever drives one at a time today.
 */
@CapacitorPlugin(name = "TcpSocket")
public class TcpSocketPlugin extends Plugin {

    private static final String TAG = "[peer-sync]";
    private static final int READ_BUFFER_SIZE = 16 * 1024;

    /** Live connections keyed by the JS-assigned socket id. */
    private final ConcurrentHashMap<String, Connection> connections = new ConcurrentHashMap<>();

    /** Fallback id generator if the caller omits one (defensive; JS always sends one). */
    private final AtomicLong autoId = new AtomicLong(1);

    /**
     * One TCP/TLS socket plus its dedicated reader thread. All socket I/O is
     * confined to worker threads so the WebView/main thread is never blocked,
     * and writes are synchronized on the output stream so concurrent
     * writes from the JS write queue cannot interleave bytes.
     */
    private final class Connection {
        final String id;
        final Socket socket;
        final OutputStream out;
        final Thread reader;
        volatile boolean closed = false;

        Connection(String id, Socket socket) throws IOException {
            this.id = id;
            this.socket = socket;
            this.out = socket.getOutputStream();
            this.reader = new Thread(this::readLoop, "tcp-reader-" + id);
            this.reader.setDaemon(true);
        }

        void start() {
            reader.start();
        }

        private void readLoop() {
            byte[] buffer = new byte[READ_BUFFER_SIZE];
            try {
                InputStream in = socket.getInputStream();
                int n;
                while (!closed && (n = in.read(buffer)) != -1) {
                    String b64 = Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP);
                    JSObject ev = new JSObject();
                    ev.put("id", id);
                    ev.put("data", b64);
                    notifyListeners("data", ev);
                }
                // Clean EOF (remote closed). Emit `close` so the Duplex ends.
                emitClose();
            } catch (Exception ex) {
                // A read error after we already initiated close is expected —
                // don't surface it as an error in that case, just close.
                if (!closed) {
                    emitError(ex.getMessage() != null ? ex.getMessage() : "read error");
                }
                emitClose();
            }
        }

        void write(byte[] bytes) throws IOException {
            synchronized (out) {
                out.write(bytes);
                out.flush();
            }
        }

        void shutdown() {
            if (closed) return;
            closed = true;
            try {
                socket.close();
            } catch (Exception ignored) {
                // Already-closed sockets throw; nothing to do.
            }
        }

        private void emitClose() {
            // Drop our registration first so a duplicate close from the reader
            // loop (EOF then catch) only fires the JS `close` once per id.
            if (connections.remove(id) == null) return;
            JSObject ev = new JSObject();
            ev.put("id", id);
            notifyListeners("close", ev);
        }

        private void emitError(String message) {
            JSObject ev = new JSObject();
            ev.put("id", id);
            ev.put("message", message);
            notifyListeners("error", ev);
        }
    }

    @PluginMethod
    public void open(final PluginCall call) {
        final String id = call.getString("id", String.valueOf(autoId.getAndIncrement()));
        final String host = call.getString("host");
        final Integer port = call.getInt("port");
        final boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        final boolean rejectUnauthorized = Boolean.TRUE.equals(call.getBoolean("rejectUnauthorized", true));

        if (host == null || host.isEmpty() || port == null) {
            call.reject("host and port are required");
            return;
        }

        // Connect off the main thread — Socket.connect / TLS handshake block.
        new Thread(() -> {
            try {
                Socket socket;
                if (tls) {
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    if (rejectUnauthorized) {
                        ctx.init(null, null, null);
                    } else {
                        // Opt-out path for self-signed brokers on the LAN. Mirrors
                        // the WS transport's rejectUnauthorized:false behaviour so
                        // a user pointing at their own mosquitto with a self-signed
                        // cert isn't blocked. Default stays strict.
                        ctx.init(null, trustAllManagers(), new java.security.SecureRandom());
                    }
                    SSLSocket sslSocket = (SSLSocket) ctx.getSocketFactory().createSocket();
                    sslSocket.connect(new InetSocketAddress(host, port), 10_000);
                    sslSocket.startHandshake();
                    socket = sslSocket;
                } else {
                    socket = new Socket();
                    socket.connect(new InetSocketAddress(host, port), 10_000);
                }
                socket.setTcpNoDelay(true);

                Connection conn = new Connection(id, socket);
                Connection prev = connections.put(id, conn);
                if (prev != null) prev.shutdown();
                conn.start();

                JSObject result = new JSObject();
                result.put("id", id);
                call.resolve(result);
            } catch (Exception ex) {
                String message = ex.getMessage() != null ? ex.getMessage() : "connect failed";
                // Surface as BOTH a rejected call and an `error`/`close` event so
                // the JS Duplex tears down and mqtt.js retries — never throws.
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("message", message);
                notifyListeners("error", ev);
                JSObject closeEv = new JSObject();
                closeEv.put("id", id);
                notifyListeners("close", closeEv);
                call.reject(message);
            }
        }, "tcp-open-" + id).start();
    }

    @PluginMethod
    public void write(final PluginCall call) {
        final String id = call.getString("id");
        final String data = call.getString("data");
        if (id == null || data == null) {
            call.reject("id and data are required");
            return;
        }
        final Connection conn = connections.get(id);
        if (conn == null) {
            call.reject("socket not open");
            return;
        }
        new Thread(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
                conn.write(bytes);
                call.resolve();
            } catch (Exception ex) {
                String message = ex.getMessage() != null ? ex.getMessage() : "write failed";
                conn.emitError(message);
                conn.shutdown();
                conn.emitClose();
                call.reject(message);
            }
        }, "tcp-write-" + id).start();
    }

    @PluginMethod
    public void close(final PluginCall call) {
        final String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        final Connection conn = connections.get(id);
        if (conn != null) {
            conn.shutdown();
            conn.emitClose();
        }
        call.resolve();
    }

    /**
     * Trust-all manager used only when the JS side explicitly asks for
     * rejectUnauthorized:false (self-signed LAN brokers). Never the default.
     */
    private TrustManager[] trustAllManagers() {
        return new TrustManager[] {
            new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            }
        };
    }
}
