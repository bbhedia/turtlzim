package org.zimnotebook.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.SSLException;
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

    /** A request to the account server: `{ url, method, headers, body }` in; `{ status, headers, body }` out (the body as text). A failure is words for a person. */
    @PluginMethod
    public void request(final PluginCall call) {
        network.execute(() -> {
            try {
                call.resolve(send(call));
            } catch (AccountRules.Refused refused) {
                call.reject(refused.getMessage());
            } catch (IOException failure) {
                call.reject(describe(failure));
            } catch (RuntimeException failure) {
                call.reject("The request could not be made: " + failure.getClass().getSimpleName());
            }
        });
    }

    private JSObject send(PluginCall call) throws AccountRules.Refused, IOException {
        URI uri = AccountRules.checkUrl(call.getString("url"));
        String method = (call.getString("method") == null ? "GET" : call.getString("method")).toUpperCase(Locale.ROOT);
        if (!AccountRules.METHODS.contains(method)) throw new AccountRules.Refused("That is not a request that this app makes.");
        String text = call.getString("body");
        byte[] body = text == null ? null : text.getBytes(StandardCharsets.UTF_8);
        if (body != null && body.length > AccountRules.MAX_BODY) throw new AccountRules.Refused("That request is too big.");

        Request.Builder builder = new Request.Builder().url(uri.toString()).header("User-Agent", "ZimNotebook-Android");
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

        try (Response response = client.newCall(builder.build()).execute()) {
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

    /** A failure of a request in words that a person can act on (a certificate that this device does not trust is the one that matters most). */
    static String describe(IOException failure) {
        if (failure instanceof SSLException) return "The server's certificate is not one that this device trusts (" + failure.getMessage() + ").";
        if (failure instanceof UnknownHostException) return "The server's name was not found: check the address, and that this device is online.";
        if (failure instanceof ConnectException) return "The server did not answer: check the address, and that this device is online.";
        if (failure instanceof SocketTimeoutException) return "The server took too long to answer.";
        String message = failure.getMessage();
        return message == null || message.isEmpty() ? "The request could not be made." : message;
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
