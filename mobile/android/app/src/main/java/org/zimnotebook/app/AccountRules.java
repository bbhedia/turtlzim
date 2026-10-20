package org.zimnotebook.app;

import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import okhttp3.HttpUrl;

/**
 * What the app may ask of the network, and with what: the rules of {@link ZimNativePlugin}, kept apart from Android so that they are tried on a plain JVM
 * (`gradlew testDebugUnitTest`). They are the rules of the desktop program too (`desktop/src-tauri/src/account.rs`): an https address (or http to this device's own address,
 * which is how a server is tried out), an `/api/` path of the server, no name or password in the address, a few headers, and no redirect followed.
 */
final class AccountRules {
    private AccountRules() {}

    /** What the page may send along with a request: the others (a cookie, an origin, a referrer, whatever its engine adds) are the page's, and not an app's. */
    static final Set<String> FORWARDED = Set.of("authorization", "content-type", "x-requested-with", "accept");
    /** The requests that this app makes. */
    static final Set<String> METHODS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE");
    /** The most that a request may carry and an answer may be (a notebook's files are sent as base64 in JSON; the server's own limits are well under these). */
    static final int MAX_BODY = 16 * 1024 * 1024;
    static final int MAX_ANSWER = 32 * 1024 * 1024;

    private static final Pattern LOOPBACK_V4 = Pattern.compile("^127\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)$");
    private static final Pattern SECRET_NAME = Pattern.compile("^[A-Za-z0-9-]{1,64}$");

    /** A request that is not to be made, with the reason in words for a person. */
    static final class Refused extends Exception {
        Refused(String message) {
            super(message);
        }
    }

    static boolean isLoopback(String host) {
        if (host == null) return false;
        String lower = host.toLowerCase(Locale.ROOT);
        return lower.equals("localhost") || lower.equals("[::1]") || LOOPBACK_V4.matcher(lower).matches();
    }

    /** The address of a request that may be made. */
    static URI checkUrl(String raw) throws Refused {
        URI uri;
        try {
            uri = new URI(raw == null ? "" : raw);
        } catch (java.net.URISyntaxException e) {
            throw new Refused("That is not an address.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null) throw new Refused("That is not an address.");
        if (scheme.equals("https")) {
            // fine
        } else if (scheme.equals("http")) {
            if (!isLoopback(host)) throw new Refused("A server that is not on this device has to be reached over https.");
        } else {
            throw new Refused("That is not an address of a server.");
        }
        if (uri.getRawUserInfo() != null) throw new Refused("There is no name or password in the address of the server.");
        String path = uri.getRawPath() == null ? "" : uri.getRawPath();
        if (uri.getRawFragment() != null || !path.startsWith("/api/") || path.contains("/../") || path.endsWith("/..")) throw new Refused("That is not a request to the account server.");
        // (the request is made from this same text, which the client reads with its own parser, and that one resolves a dot segment however it is written, `%2e%2e` too, where
        // `java.net.URI` does not: the path that counts is the one it makes of it, as it is for the desktop program, whose `Url::parse` is the parser of its requests. The host and
        // the name are read alike by both, because `java.net.URI` refuses what would make them differ: a backslash, a space, a percent sign in a host)
        HttpUrl read = HttpUrl.parse(uri.toString());
        if (read == null || !read.encodedPath().startsWith("/api/")) throw new Refused("That is not a request to the account server.");
        return uri;
    }

    /** The address that the person's browser may be sent to (an https page, or one on this device): what the page may ask the app to open. */
    static URI checkBrowserUrl(String raw) throws Refused {
        URI uri;
        try {
            uri = new URI(raw == null ? "" : raw);
        } catch (java.net.URISyntaxException e) {
            throw new Refused("That is not an address.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        boolean ok = host != null && (scheme.equals("https") || (scheme.equals("http") && isLoopback(host)));
        if (!ok) throw new Refused("A browser is only sent to an https address (or to one on this device).");
        if (uri.getRawUserInfo() != null) throw new Refused("There is no name or password in the address of the server.");
        return uri;
    }

    static boolean forwards(String headerName) {
        return FORWARDED.contains(headerName.toLowerCase(Locale.ROOT));
    }

    /** Whether a name is one that a secret can have (it is part of a key of the app's own storage). */
    static boolean validSecretName(String name) {
        return name != null && SECRET_NAME.matcher(name).matches();
    }
}
