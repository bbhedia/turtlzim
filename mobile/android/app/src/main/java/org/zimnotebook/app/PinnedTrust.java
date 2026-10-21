package org.zimnotebook.app;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * A server whose certificate the system does not know (a self-signed one, or one made by an authority of the person's own), trusted by its fingerprint after the person has looked at it
 * and compared it with the one that the server's own console shows. The rules are here, with nothing of Android's own in them, so that they are tried on a plain JVM
 * (`gradlew testDebugUnitTest`); `ZimNativePlugin` keeps what was trusted and makes the requests. They are the rules of the desktop program too (`desktop/src-tauri/src/tls.rs`).
 *
 * The check is made in the handshake, where it can't be got round: {@link Pin} is the trust manager of a connection to a server that has a certificate trusted for it, and it takes the one
 * certificate that has the fingerprint and nothing else, so that **no byte of a request is sent** to a server that shows another one. The system's own trust is not asked about such a server
 * at all (a certificate made by an authority that the system knows is someone else's, to this address, not the one that was trusted). Looking at what a server shows ({@link #look}) is a
 * handshake and nothing more: nothing is sent to a server that the person has not trusted yet.
 */
final class PinnedTrust {
    private PinnedTrust() {}

    /** The codes of a refusal for the sake of a certificate: the page acts on these two (`web/src/app/shell.ts` has them too, and a test makes sure that they agree). */
    static final String CERTIFICATE_UNTRUSTED = "certificate-untrusted";
    static final String CERTIFICATE_CHANGED = "certificate-changed";

    private static final int TIMEOUT_MS = 15_000;

    /** The SHA-256 of a certificate (as the server sent it: DER) as 32 pairs of capital hexadecimal digits with a colon between them, which is what `openssl x509 -noout -fingerprint -sha256` says. */
    static String fingerprint(byte[] der) {
        return format(sha256(der));
    }

    static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static String format(byte[] digest) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < digest.length; i++) {
            if (i > 0) text.append(':');
            text.append(String.format("%02X", digest[i] & 0xff));
        }
        return text.toString();
    }

    /** The 32 bytes of a fingerprint written any of the usual ways (capitals or not, a colon or a space between the pairs, or nothing); null if it is not exactly 32 bytes of hexadecimal. */
    static byte[] parse(String text) {
        if (text == null) return null;
        StringBuilder digits = new StringBuilder();
        for (char c : text.toCharArray()) if (c != ':' && c != ' ') digits.append(c);
        if (digits.length() != 64) return null;
        byte[] bytes = new byte[32];
        for (int i = 0; i < 32; i++) {
            int high = Character.digit(digits.charAt(2 * i), 16);
            int low = Character.digit(digits.charAt(2 * i + 1), 16);
            if (high < 0 || low < 0) return null;
            bytes[i] = (byte) (high * 16 + low);
        }
        return bytes;
    }

    /** The certificate that a server showed is not the one that was trusted for it. It carries the fingerprint of the one that was shown. */
    static final class Mismatch extends CertificateException {
        final String shown;

        Mismatch(String shown) {
            super("The server's certificate is not the one that was trusted for it.");
            this.shown = shown;
        }
    }

    /** The trust manager of a connection to a server that a certificate was trusted for: it takes the certificate with this fingerprint, as the first of what the server sent, and nothing else. */
    static final class Pin implements X509TrustManager {
        private final byte[] wanted;

        Pin(byte[] wanted) {
            if (wanted == null || wanted.length != 32) throw new IllegalArgumentException("a fingerprint is 32 bytes");
            this.wanted = wanted.clone();
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0 || chain[0] == null) throw new CertificateException("The server showed no certificate.");
            byte[] shown = sha256(chain[0].getEncoded());
            if (!MessageDigest.isEqual(shown, wanted)) throw new Mismatch(format(shown));
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("This app is a client and shows no certificate.");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /**
     * A trust manager that takes any certificate. It is for **looking** at what a server shows, which is a handshake and nothing else: it is given to the one socket that {@link #look} makes,
     * which is closed without a byte written, and to no connection that anything is sent on.
     */
    private static final class Look implements X509TrustManager {
        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {
            // (what the server showed is read by the caller, and judged by the person)
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("This app is a client and shows no certificate.");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /** The sockets of a connection that only takes the certificate that {@code pin} says. */
    static SSLSocketFactory socketFactory(X509TrustManager manager) throws GeneralSecurityException {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { manager }, null);
        return context.getSocketFactory();
    }

    /** What a certificate says of itself, as far as it can be read: only the fingerprint counts, and the rest is what a person is shown. */
    static final class Info {
        final byte[] digest;
        final String fingerprint;
        final String subject;
        final String issuer;
        final List<String> names;
        final long notBefore;
        final long notAfter;

        Info(X509Certificate certificate) throws CertificateException {
            this.digest = sha256(certificate.getEncoded());
            this.fingerprint = format(digest);
            this.subject = certificate.getSubjectX500Principal().getName(javax.security.auth.x500.X500Principal.RFC1779);
            this.issuer = certificate.getIssuerX500Principal().getName(javax.security.auth.x500.X500Principal.RFC1779);
            this.names = namesOf(certificate);
            this.notBefore = certificate.getNotBefore().getTime();
            this.notAfter = certificate.getNotAfter().getTime();
        }
    }

    /** The host names and addresses that a certificate says it is good for (the "subject alternative names" of those two kinds). */
    static List<String> namesOf(X509Certificate certificate) {
        List<String> names = new ArrayList<>();
        try {
            Collection<List<?>> alternatives = certificate.getSubjectAlternativeNames();
            if (alternatives != null) {
                for (List<?> alternative : alternatives) {
                    if (alternative.size() == 2 && alternative.get(1) instanceof String && (Integer.valueOf(2).equals(alternative.get(0)) || Integer.valueOf(7).equals(alternative.get(0)))) names.add((String) alternative.get(1));
                }
            }
        } catch (CertificateException unreadable) {
            // (a certificate whose names can't be read has none to show)
        }
        return names;
    }

    /**
     * What the server at this address shows as its certificate, found out by a handshake and nothing else: the connection is closed as soon as the certificate is read, with nothing written
     * to it.
     */
    static Info look(String host, int port) throws IOException, GeneralSecurityException {
        Socket plain = new Socket();
        try {
            plain.connect(new InetSocketAddress(host, port), TIMEOUT_MS);
            plain.setSoTimeout(TIMEOUT_MS);
            // (layered over the socket that was reached, so that a host name is what the handshake names: the server needs it to know which certificate to show)
            try (SSLSocket socket = (SSLSocket) socketFactory(new Look()).createSocket(plain, host, port, true)) {
                socket.startHandshake();
                java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
                if (chain.length == 0 || !(chain[0] instanceof X509Certificate)) throw new CertificateException("The server showed no certificate.");
                return new Info((X509Certificate) chain[0]);
            }
        } finally {
            try {
                plain.close();
            } catch (IOException alreadyClosed) {
                // (nothing to do)
            }
        }
    }
}
