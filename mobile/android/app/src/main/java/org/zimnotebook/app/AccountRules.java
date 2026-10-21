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

    /**
     * The address of a server that a certificate can be trusted for (the page names it: `https://host:port`): https, a host, at most a port, and nothing after it. (A certificate is trusted for a
     * server, not for a page of it; an address that is not https has no certificate to trust.)
     */
    static HttpUrl checkOrigin(String raw) throws Refused {
        HttpUrl url = raw == null ? null : HttpUrl.parse(raw);
        if (url == null) throw new Refused("That is not an address.");
        if (!url.isHttps()) throw new Refused("A certificate can be trusted only for an https address.");
        if (!url.encodedUsername().isEmpty() || !url.encodedPassword().isEmpty()) throw new Refused("There is no name or password in the address of the server.");
        if (!url.encodedPath().equals("/") || url.encodedQuery() != null || url.encodedFragment() != null) throw new Refused("A certificate is trusted for a server, not for a page of it.");
        return url;
    }

    /** The key that what is trusted for a server is kept under: `https://host:port`, the port always there (the default one written out) and an IPv6 address in brackets. */
    static String originKey(HttpUrl url) {
        String host = url.host();
        return "https://" + (host.indexOf(':') >= 0 ? "[" + host + "]" : host) + ":" + url.port();
    }

    /** Whether a failure of a request was about the server's certificate (and not about getting to the server): somewhere in its causes the certificate, or its name, was what was refused. */
    static boolean isCertificateProblem(Throwable failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.security.cert.CertificateException || cause instanceof java.security.cert.CertPathValidatorException || cause instanceof javax.net.ssl.SSLPeerUnverifiedException) return true;
            if (cause.getCause() == cause) break;
        }
        return false;
    }

    /**
     * The reason that the system gave for refusing a certificate, as a short line for a person: the message of the deepest cause that has one, its first line, without the name of the exception
     * that carries it and without a full stop or a colon at its end (empty when there is none).
     */
    static String reasonOf(Throwable failure) {
        String reason = "";
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause.getMessage() != null && !cause.getMessage().trim().isEmpty()) reason = cause.getMessage();
            if (cause.getCause() == cause) break;
        }
        int end = reason.indexOf('\n');
        if (end >= 0) reason = reason.substring(0, end);
        return reason.trim().replaceFirst("^[\\w.$]+(Exception|Error): ", "").replaceFirst("[.:]+$", "").trim();
    }

    /** A request that could not be made: the words for a person and, for the two ways that a certificate is refused, the code that the page acts on (else null). */
    static final class Failure {
        final String message;
        final String code;

        Failure(String message, String code) {
            this.message = message;
            this.code = code;
        }
    }

    /**
     * A failure of a request in words that a person can act on (a certificate that this device does not trust is the one that matters most), with the code that the page acts on when it was
     * about the certificate: the server showed another one than the one that was trusted for it, or one that the system does not know.
     */
    static Failure describe(java.io.IOException failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof PinnedTrust.Mismatch) return new Failure("The server's certificate is not the one that you trusted for it.", PinnedTrust.CERTIFICATE_CHANGED);
            if (cause.getCause() == cause) break;
        }
        if (isCertificateProblem(failure)) {
            String reason = reasonOf(failure);
            return new Failure("The server's certificate is not one that this device trusts" + (reason.isEmpty() ? "" : " (" + reason + ")") + ".", PinnedTrust.CERTIFICATE_UNTRUSTED);
        }
        if (failure instanceof javax.net.ssl.SSLException) return new Failure("A secure connection to the server could not be set up (" + failure.getMessage() + ").", null);
        if (failure instanceof java.net.UnknownHostException) return new Failure("The server's name was not found: check the address, and that this device is online.", null);
        if (failure instanceof java.net.ConnectException) return new Failure("The server did not answer: check the address, and that this device is online.", null);
        if (failure instanceof java.net.SocketTimeoutException) return new Failure("The server took too long to answer.", null);
        String message = failure.getMessage();
        return new Failure(message == null || message.isEmpty() ? "The request could not be made." : message, null);
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
