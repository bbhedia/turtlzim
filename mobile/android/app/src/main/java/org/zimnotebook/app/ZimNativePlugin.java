package org.zimnotebook.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSource;

/**
 * What the app does for an account that a WebView does not: the requests to the account server (the page's content policy lets it ask nowhere but its own address, and a
 * shell's address is not the server's), and a place for the token (a key in the Android Keystore, which never leaves it, seals the value that is kept in the app's own private
 * storage). `web/src/account/native.ts` is the page's side; `mobile/shell/shell.ts` sets the hooks over these methods. The rules of what may be asked are in {@link AccountRules}.
 */
@CapacitorPlugin(name = "ZimNative")
public class ZimNativePlugin extends Plugin {
    private static final String KEY_ALIAS = "zim-notebook-secrets";
    private static final String PREFERENCES = "zim_secrets";

    /** One request at a time per thread; the plugin's own thread is not held for the time that a server takes. */
    private final ExecutorService network = Executors.newCachedThreadPool();

    /** What the person trusted for servers that the system does not know: a fingerprint for each (`https://host:port`), kept in the app's own private preferences. */
    private static final String PINS = "zim_pins";

    /** The clients for servers that have a certificate trusted for them, by that certificate's fingerprint (a connection made under one is reused only by requests that take the same one). */
    private final ConcurrentHashMap<String, OkHttpClient> pinned = new ConcurrentHashMap<>();

    /** No redirect is followed: the token is for the server that was typed, and goes to no other. The system's trusted authorities are used (and its proxy settings). */
    private final OkHttpClient client = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .callTimeout(180, TimeUnit.SECONDS)
        .build();

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // the requests

    private void reject(PluginCall call, AccountRules.Failure failure) {
        String code = failure.code;
        call.reject(failure.message, code);
    }

    /**
     * A request to the account server: `{ url, method, headers, body }` in; `{ status, headers, body }` out (the body as text). A failure is words for a person, and, when it is about the
     * server's certificate, a `code` too: the system does not know it and nothing was trusted for this server (`certificate-untrusted`), or something was and the server shows another
     * (`certificate-changed`).
     */
    @PluginMethod
    public void request(final PluginCall call) {
        network.execute(() -> {
            try {
                call.resolve(send(call));
            } catch (AccountRules.Refused refused) {
                call.reject(refused.getMessage());
            } catch (IOException failure) {
                reject(call, AccountRules.describe(failure));
            } catch (RuntimeException failure) {
                call.reject("The request could not be made: " + failure.getClass().getSimpleName());
            }
        });
    }

    private SharedPreferences pins() {
        return getContext().getSharedPreferences(PINS, Context.MODE_PRIVATE);
    }

    /**
     * The client for a request: the one that takes the system's trust, or, for a server that has a certificate trusted for it, one whose connection takes that certificate and nothing else
     * (checked in the handshake, so that nothing is sent to a server that shows another; the host name is not what is checked then, the certificate is). A trust that can't be read is no trust:
     * the system is asked, and refuses what it does not know.
     */
    private OkHttpClient clientFor(HttpUrl target) {
        if (!target.isHttps()) return client;
        byte[] wanted = PinnedTrust.parse(pins().getString(AccountRules.originKey(target), null));
        if (wanted == null) return client;
        return pinned.computeIfAbsent(PinnedTrust.format(wanted), key -> {
            PinnedTrust.Pin manager = new PinnedTrust.Pin(wanted);
            try {
                return client.newBuilder().sslSocketFactory(PinnedTrust.socketFactory(manager), manager).hostnameVerifier((host, session) -> true).build();
            } catch (GeneralSecurityException impossible) {
                throw new IllegalStateException(impossible);
            }
        });
    }

    private JSObject send(PluginCall call) throws AccountRules.Refused, IOException {
        URI uri = AccountRules.checkUrl(call.getString("url"));
        HttpUrl target = HttpUrl.parse(uri.toString());
        if (target == null) throw new AccountRules.Refused("That is not an address.");
        String method = (call.getString("method") == null ? "GET" : call.getString("method")).toUpperCase(Locale.ROOT);
        if (!AccountRules.METHODS.contains(method)) throw new AccountRules.Refused("That is not a request that this app makes.");
        String text = call.getString("body");
        byte[] body = text == null ? null : text.getBytes(StandardCharsets.UTF_8);
        if (body != null && body.length > AccountRules.MAX_BODY) throw new AccountRules.Refused("That request is too big.");

        Request.Builder builder = new Request.Builder().url(target).header("User-Agent", "ZimNotebook-Android");
        JSObject headers = call.getObject("headers");
        String contentType = "application/json";
        if (headers != null) {
            for (Iterator<String> names = headers.keys(); names.hasNext(); ) {
                String name = names.next();
                if (!AccountRules.forwards(name)) continue;
                String value = headers.getString(name);
                if (value == null) continue;
                if (name.equalsIgnoreCase("content-type")) contentType = value;
                builder.header(name, value);
            }
        }
        boolean carries = method.equals("POST") || method.equals("PUT") || method.equals("PATCH");
        RequestBody requestBody = carries ? RequestBody.create(body == null ? new byte[0] : body, okhttp3.MediaType.parse(contentType)) : null;
        builder.method(method, requestBody);

        try (Response response = clientFor(target).newCall(builder.build()).execute()) {
            JSObject answer = new JSObject();
            answer.put("status", response.code());
            JSObject seen = new JSObject();
            for (String name : response.headers().names()) seen.put(name.toLowerCase(Locale.ROOT), response.header(name));
            answer.put("headers", seen);
            String content = "";
            if (response.body() != null) {
                BufferedSource source = response.body().source();
                if (source.request(AccountRules.MAX_ANSWER + 1L)) throw new IOException("The server's answer is too big.");
                content = source.readString(StandardCharsets.UTF_8);
            }
            answer.put("body", content);
            return answer;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // a server whose certificate the system does not know (PinnedTrust): looked at, trusted by its fingerprint, and forgotten

    private static JSObject infoOf(PinnedTrust.Info info) {
        JSObject answer = new JSObject();
        answer.put("fingerprint", info.fingerprint);
        answer.put("subject", info.subject);
        answer.put("issuer", info.issuer);
        JSArray names = new JSArray();
        for (String name : info.names) names.put(name);
        answer.put("names", names);
        answer.put("notBefore", info.notBefore);
        answer.put("notAfter", info.notAfter);
        return answer;
    }

    /** What the server at this origin shows as its certificate, found out by a handshake and nothing else: no request is made, so nothing is sent to a server that was not trusted yet. */
    @PluginMethod
    public void trustInspect(final PluginCall call) {
        network.execute(() -> {
            try {
                HttpUrl url = AccountRules.checkOrigin(call.getString("origin"));
                call.resolve(infoOf(PinnedTrust.look(url.host(), url.port())));
            } catch (AccountRules.Refused refused) {
                call.reject(refused.getMessage());
            } catch (IOException failure) {
                reject(call, AccountRules.describe(failure));
            } catch (GeneralSecurityException | RuntimeException failure) {
                call.reject("The certificate could not be looked at: " + failure.getClass().getSimpleName());
            }
        });
    }

    /** Trust the certificate with this fingerprint for this origin, if the server shows it now (it is looked at again: what the person was shown is not taken for what the server shows). */
    @PluginMethod
    public void trustPin(final PluginCall call) {
        network.execute(() -> {
            try {
                HttpUrl url = AccountRules.checkOrigin(call.getString("origin"));
                byte[] wanted = PinnedTrust.parse(call.getString("fingerprint"));
                if (wanted == null) {
                    call.reject("That is not a fingerprint.");
                    return;
                }
                PinnedTrust.Info shown = PinnedTrust.look(url.host(), url.port());
                if (!MessageDigest.isEqual(shown.digest, wanted)) {
                    String code = PinnedTrust.CERTIFICATE_CHANGED;
                    call.reject("The server shows another certificate now, so nothing was trusted.", code);
                    return;
                }
                if (!pins().edit().putString(AccountRules.originKey(url), PinnedTrust.format(wanted)).commit()) {
                    call.reject("The device would not keep it.");
                    return;
                }
                call.resolve();
            } catch (AccountRules.Refused refused) {
                call.reject(refused.getMessage());
            } catch (IOException failure) {
                reject(call, AccountRules.describe(failure));
            } catch (GeneralSecurityException | RuntimeException failure) {
                call.reject("The certificate could not be trusted: " + failure.getClass().getSimpleName());
            }
        });
    }

    /** The fingerprint that was trusted for this origin, or null. */
    @PluginMethod
    public void trustPinned(PluginCall call) {
        try {
            HttpUrl url = AccountRules.checkOrigin(call.getString("origin"));
            String kept = pins().getString(AccountRules.originKey(url), null);
            JSObject answer = new JSObject();
            answer.put("fingerprint", PinnedTrust.parse(kept) == null ? JSObject.NULL : kept);
            call.resolve(answer);
        } catch (AccountRules.Refused refused) {
            call.reject(refused.getMessage());
        }
    }

    /** Stop trusting what was trusted for this origin (that nothing was is not a failure). */
    @PluginMethod
    public void trustUnpin(PluginCall call) {
        try {
            HttpUrl url = AccountRules.checkOrigin(call.getString("origin"));
            pins().edit().remove(AccountRules.originKey(url)).commit();
            call.resolve();
        } catch (AccountRules.Refused refused) {
            call.reject(refused.getMessage());
        }
    }

    /** Open the person's browser at an address (https, or this device's own): where they sign in and allow the app. The browser sends them back to the app's own address. */
    @PluginMethod
    public void openBrowser(PluginCall call) {
        try {
            URI uri = AccountRules.checkBrowserUrl(call.getString("url"));
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())).addCategory(Intent.CATEGORY_BROWSABLE));
            call.resolve();
        } catch (AccountRules.Refused refused) {
            call.reject(refused.getMessage());
        } catch (ActivityNotFoundException none) {
            call.reject("No browser was found on this device.");
        }
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // the token

    private SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(
                new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            );
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }

    private SharedPreferences secrets() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    /** The secret under a name, or null. */
    @PluginMethod
    public void secretGet(PluginCall call) {
        String name = call.getString("name");
        if (!AccountRules.validSecretName(name)) {
            call.reject("That is not a name that a secret can have.");
            return;
        }
        String sealed = secrets().getString("secret-" + name, null);
        JSObject answer = new JSObject();
        if (sealed == null) {
            answer.put("value", JSObject.NULL);
            call.resolve(answer);
            return;
        }
        try {
            byte[] bytes = Base64.decode(sealed, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 0, 12));
            answer.put("value", new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8));
            call.resolve(answer);
        } catch (GeneralSecurityException | IOException | RuntimeException failure) {
            // (a secret that can't be opened, because the key was lost with a restored device or a changed lock, is no secret: it is forgotten, and the person signs in again)
            secrets().edit().remove("secret-" + name).apply();
            answer.put("value", JSObject.NULL);
            call.resolve(answer);
        }
    }

    /** Keep a secret under a name: sealed by the Keystore's key, in the app's private storage. */
    @PluginMethod
    public void secretSet(PluginCall call) {
        String name = call.getString("name");
        String value = call.getString("value");
        if (!AccountRules.validSecretName(name) || value == null) {
            call.reject("That is not a secret that can be kept.");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] both = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, both, 0, iv.length);
            System.arraycopy(sealed, 0, both, iv.length, sealed.length);
            if (!secrets().edit().putString("secret-" + name, Base64.encodeToString(both, Base64.NO_WRAP)).commit()) {
                call.reject("The device would not keep it.");
                return;
            }
            call.resolve();
        } catch (GeneralSecurityException | IOException | RuntimeException failure) {
            call.reject("The device's keystore would not seal it: " + failure.getClass().getSimpleName());
        }
    }

    /** Forget a secret. */
    @PluginMethod
    public void secretRemove(PluginCall call) {
        String name = call.getString("name");
        if (!AccountRules.validSecretName(name)) {
            call.reject("That is not a name that a secret can have.");
            return;
        }
        secrets().edit().remove("secret-" + name).commit();
        call.resolve();
    }
}
