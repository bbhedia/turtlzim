package org.zimnotebook.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.junit.Test;

/**
 * A server whose certificate the system does not know, trusted by its fingerprint (PinnedTrust, AccountRules.describe): the same rules as the desktop program's (`tls.rs`), tried here on a
 * plain JVM against a real TLS server that shows one of two certificates that nothing trusts. The device test tries the same on the emulator, with Android's own TLS.
 */
public class PinnedTrustTest {
    // what `openssl x509 -noout -fingerprint -sha256` says of each of the two certificates (src/test/resources): a known answer that does not come from the code that is tried
    static final String FP_A = "93:B9:5C:F3:A9:7D:EA:48:7F:20:8A:87:CA:FA:03:DB:E1:C3:50:85:3A:D7:A0:64:02:86:98:6D:5C:FF:F5:55";
    static final String FP_B = "AA:5A:95:F1:7D:5A:44:04:6D:FD:8C:04:E4:F0:16:21:5C:57:E6:13:B6:D0:71:5E:EC:CA:65:ED:8E:DD:12:92";
    /** What the key of each certificate is kept under, in `pin-a.p12` and `pin-b.p12` (no secret: the key is for these tests). */
    static final char[] PASSWORD = "zim-test".toCharArray();

    private static String text(String name) throws IOException {
        try (InputStream in = PinnedTrustTest.class.getResourceAsStream("/" + name)) {
            assertNotNull(name, in);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }

    static X509Certificate certificate(String which) throws Exception {
        try (InputStream in = PinnedTrustTest.class.getResourceAsStream("/pin-" + which + ".pem")) {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
        }
    }

    /**
     * A TLS server on this machine that shows certificate A or B and answers every request with a small page. What each connection sent after the handshake, as the server read it, comes
     * out of {@link #seen} when that connection is over: nothing, for a client that left after the handshake.
     */
    static final class Server implements AutoCloseable {
        private static final byte[] ANSWER = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".getBytes(StandardCharsets.US_ASCII);
        final SSLServerSocket socket;
        final BlockingQueue<byte[]> seen = new LinkedBlockingQueue<>();

        Server(String which) throws Exception {
            KeyStore store = KeyStore.getInstance("PKCS12");
            try (InputStream in = PinnedTrustTest.class.getResourceAsStream("/pin-" + which + ".p12")) {
                assertNotNull(which, in);
                store.load(in, PASSWORD);
            }
            KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            keys.init(store, PASSWORD);
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(keys.getKeyManagers(), null, null);
            socket = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 50, InetAddress.getLoopbackAddress());
            Thread thread = new Thread(this::run, "tls-stand-in");
            thread.setDaemon(true);
            thread.start();
        }

        int port() {
            return socket.getLocalPort();
        }

        private void run() {
            while (!socket.isClosed()) {
                try (SSLSocket client = (SSLSocket) socket.accept()) {
                    client.setSoTimeout(5000);
                    ByteArrayOutputStream read = new ByteArrayOutputStream();
                    try {
                        client.startHandshake();
                        InputStream in = client.getInputStream();
                        byte[] buffer = new byte[4096];
                        int n;
                        while ((n = in.read(buffer)) > 0) {
                            read.write(buffer, 0, n);
                            if (new String(read.toByteArray(), StandardCharsets.ISO_8859_1).contains("\r\n\r\n")) break;
                        }
                    } catch (IOException clientLeft) {
                        // (the client ended the connection: what it sent is what was read)
                    }
                    seen.add(read.toByteArray());
                    if (read.size() > 0) {
                        client.getOutputStream().write(ANSWER);
                        client.getOutputStream().flush();
                    }
                } catch (IOException ended) {
                    if (socket.isClosed()) return;
                }
            }
        }

        /** What the next connection to end sent, waiting for it. */
        byte[] nextSeen() throws InterruptedException {
            byte[] read = seen.poll(10, TimeUnit.SECONDS);
            assertNotNull("the server saw no connection end", read);
            return read;
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }

    /** A client as the plugin makes one for a server that has a certificate trusted for it. */
    private static OkHttpClient clientThatTakes(String fingerprint) throws Exception {
        PinnedTrust.Pin manager = new PinnedTrust.Pin(PinnedTrust.parse(fingerprint));
        return new OkHttpClient.Builder().sslSocketFactory(PinnedTrust.socketFactory(manager), manager).hostnameVerifier((host, session) -> true).followRedirects(false).build();
    }

    private static Request get(Server server, String path) {
        return new Request.Builder().url("https://127.0.0.1:" + server.port() + path).header("Authorization", "Bearer t0ken-that-must-not-leave-for-the-wrong-server").build();
    }

    @Test
    public void aFingerprintIsWhatOpensslSaysAndIsReadHoweverItIsWritten() throws Exception {
        assertEquals(FP_A, PinnedTrust.fingerprint(certificate("a").getEncoded()));
        assertEquals(FP_B, PinnedTrust.fingerprint(certificate("b").getEncoded()));
        assertEquals("E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55", PinnedTrust.fingerprint(new byte[0]));
        byte[] bytes = PinnedTrust.parse(FP_A);
        assertEquals(32, bytes.length);
        assertEquals(FP_A, PinnedTrust.format(bytes));
        for (String written : new String[] { FP_A.toLowerCase(), FP_A.replace(':', ' '), FP_A.replace(":", ""), "  " + FP_A + " " }) assertArrayEquals(written, bytes, PinnedTrust.parse(written));
        for (String wrong : new String[] { "", "93:B9", FP_A.substring(0, FP_A.length() - 3), FP_A + ":00", FP_A.replace('9', 'G'), FP_A.replace(':', '-'), "zz" }) assertNull(wrong, PinnedTrust.parse(wrong));
        assertNull(PinnedTrust.parse(null));
        // (the last digit counts)
        assertFalse(java.util.Arrays.equals(bytes, PinnedTrust.parse(FP_A.substring(0, FP_A.length() - 1) + "4")));
    }

    @Test
    public void thePinTakesTheCertificateThatHasItsFingerprintAsTheFirstOfWhatTheServerSentAndNothingElse() throws Exception {
        X509Certificate a = certificate("a");
        X509Certificate b = certificate("b");
        PinnedTrust.Pin pin = new PinnedTrust.Pin(PinnedTrust.parse(FP_A));
        pin.checkServerTrusted(new X509Certificate[] { a }, "RSA");
        pin.checkServerTrusted(new X509Certificate[] { a, b }, "RSA");
        // another certificate is refused as that, with the fingerprint of what was shown; only the first of the chain counts
        for (X509Certificate[] chain : new X509Certificate[][] { { b }, { b, a } }) {
            try {
                pin.checkServerTrusted(chain, "RSA");
                fail("a certificate that was not trusted was taken");
            } catch (PinnedTrust.Mismatch refused) {
                assertEquals(FP_B, refused.shown);
            }
        }
        // a chain that is not one is refused, and not as a certificate that changed
        for (X509Certificate[] chain : new X509Certificate[][] { null, {}, { null } }) {
            try {
                pin.checkServerTrusted(chain, "RSA");
                fail("no certificate was taken");
            } catch (PinnedTrust.Mismatch wrong) {
                fail("no certificate is not another certificate");
            } catch (CertificateException expected) {
                assertFalse(expected.getMessage().isEmpty());
            }
        }
        // this is a client: it shows no certificate, and takes none that a server would ask it for
        try {
            pin.checkClientTrusted(new X509Certificate[] { a }, "RSA");
            fail("a client certificate was taken");
        } catch (CertificateException expected) {
            // as it should be
        }
        assertEquals(0, pin.getAcceptedIssuers().length);
        // a pin that differs by one digit takes nothing of A's
        byte[] nearly = PinnedTrust.parse(FP_A);
        nearly[31] ^= 1;
        try {
            new PinnedTrust.Pin(nearly).checkServerTrusted(new X509Certificate[] { a }, "RSA");
            fail("a fingerprint that is one digit off took the certificate");
        } catch (PinnedTrust.Mismatch expected) {
            assertEquals(FP_A, expected.shown);
        }
        // and a pin is 32 bytes
        for (byte[] wrong : new byte[][] { null, new byte[0], new byte[31], new byte[33] }) {
            try {
                new PinnedTrust.Pin(wrong);
                fail("a pin that is not 32 bytes was made");
            } catch (IllegalArgumentException expected) {
                // as it should be
            }
        }
    }

    @Test
    public void whatACertificateSaysOfItselfIsWhatIsShownAndNothingIsDecidedFromIt() throws Exception {
        PinnedTrust.Info info = new PinnedTrust.Info(certificate("a"));
        assertEquals(FP_A, info.fingerprint);
        assertArrayEquals(PinnedTrust.parse(FP_A), info.digest);
        assertEquals("CN=zim test certificate A", info.subject);
        assertEquals("CN=zim test certificate A", info.issuer);
        List<String> names = info.names;
        assertTrue(names.toString(), names.contains("localhost") && names.contains("127.0.0.1") && names.size() == 3);
        assertTrue(info.notAfter > info.notBefore);
        assertTrue("good for a hundred years", info.notAfter - info.notBefore > 99L * 365 * 24 * 3600 * 1000);
    }

    @Test
    public void lookingAtAServerIsAHandshakeAndNothingMore() throws Exception {
        try (Server server = new Server("a")) {
            PinnedTrust.Info info = PinnedTrust.look("127.0.0.1", server.port());
            assertEquals(FP_A, info.fingerprint);
            assertTrue(info.names.contains("localhost"));
            // the server saw the handshake and not one byte after it
            assertEquals(0, server.nextSeen().length);
        }
        try (Server server = new Server("b")) {
            assertEquals(FP_B, PinnedTrust.look("localhost", server.port()).fingerprint);
            assertEquals(0, server.nextSeen().length);
        }
        // a server that is not there is an I/O failure, told as that and not as a certificate
        int nobody;
        try (java.net.ServerSocket free = new java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            nobody = free.getLocalPort();
        }
        try {
            PinnedTrust.look("127.0.0.1", nobody);
            fail("a server that is not there was looked at");
        } catch (IOException expected) {
            assertNull(AccountRules.describe(expected).code);
        }
    }

    @Test
    public void aRequestToAServerThatShowsTheCertificateThatWasTrustedIsMade() throws Exception {
        try (Server server = new Server("a"); Response response = clientThatTakes(FP_A).newCall(get(server, "/api/me")).execute()) {
            assertEquals(200, response.code());
            assertEquals("{}", response.body().string());
            String head = new String(server.nextSeen(), StandardCharsets.ISO_8859_1).toLowerCase();
            assertTrue(head, head.startsWith("get /api/me http/1.1"));
            assertTrue(head, head.contains("authorization: bearer t0ken"));
        }
    }

    @Test
    public void aRequestToAServerThatShowsAnotherCertificateSendsNothingAndIsToldAsChanged() throws Exception {
        // trusted: B. The server shows A.
        try (Server server = new Server("a")) {
            try {
                clientThatTakes(FP_B).newCall(get(server, "/api/me")).execute().close();
                fail("a request was made to a server that showed another certificate");
            } catch (IOException refused) {
                AccountRules.Failure told = AccountRules.describe(refused);
                assertEquals(PinnedTrust.CERTIFICATE_CHANGED, told.code);
                assertTrue(told.message, told.message.contains("not the one that you trusted"));
                assertFalse("an address does not come back with a failure: " + told.message, told.message.contains(String.valueOf(server.port())));
            }
            // what the server read after the handshake: nothing (the token did not leave)
            assertEquals(0, server.nextSeen().length);
            // and the one that was trusted is taken at once on the next try, with the same server
            try (Response response = clientThatTakes(FP_A).newCall(get(server, "/api/me")).execute()) {
                assertEquals(200, response.code());
            }
        }
    }

    @Test
    public void aServerThatTheSystemDoesNotKnowIsRefusedByTheSystemsOwnTrustAndToldAsThat() throws Exception {
        try (Server server = new Server("a")) {
            try {
                new OkHttpClient.Builder().build().newCall(get(server, "/api/me")).execute().close();
                fail("the system took a certificate that it does not know");
            } catch (IOException refused) {
                AccountRules.Failure told = AccountRules.describe(refused);
                assertEquals(PinnedTrust.CERTIFICATE_UNTRUSTED, told.code);
                assertTrue(told.message, told.message.contains("not one that this device trusts"));
            }
            assertEquals(0, server.nextSeen().length);
        }
    }

    @Test
    public void aFailureIsToldAsAboutTheCertificateOnlyIfItWasAndTheDifferentWaysItCanBeAreTold() {
        // about the certificate: what the trust manager refused, however deep it is in the causes
        SSLHandshakeException changed = new SSLHandshakeException("handshake failed");
        changed.initCause(new PinnedTrust.Mismatch(FP_B));
        assertEquals(PinnedTrust.CERTIFICATE_CHANGED, AccountRules.describe(changed).code);
        SSLHandshakeException unknown = new SSLHandshakeException("handshake failed");
        unknown.initCause(new CertPathValidatorException("Trust anchor for certification path not found."));
        assertEquals(PinnedTrust.CERTIFICATE_UNTRUSTED, AccountRules.describe(unknown).code);
        SSLHandshakeException nameless = new SSLHandshakeException("handshake failed");
        nameless.initCause(new CertificateException("the certificate is for another name"));
        assertEquals(PinnedTrust.CERTIFICATE_UNTRUSTED, AccountRules.describe(nameless).code);
        assertEquals(PinnedTrust.CERTIFICATE_UNTRUSTED, AccountRules.describe(new SSLPeerUnverifiedException("Hostname 127.0.0.1 not verified")).code);
        // the reason is the system's own, short: without the name of the exception that carries it, and without its full stop
        SSLHandshakeException worded = new SSLHandshakeException("java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.");
        worded.initCause(new CertPathValidatorException("Trust anchor for certification path not found."));
        assertEquals("The server's certificate is not one that this device trusts (Trust anchor for certification path not found).", AccountRules.describe(worded).message);
        SSLPeerUnverifiedException named = new SSLPeerUnverifiedException("Hostname 127.0.0.1 not verified:\n    certificate: sha256/abc\n    DN: CN=x");
        assertEquals("The server's certificate is not one that this device trusts (Hostname 127.0.0.1 not verified).", AccountRules.describe(named).message);
        assertEquals("The server's certificate is not one that this device trusts.", AccountRules.describe(new SSLPeerUnverifiedException("")).message);
        assertEquals("", AccountRules.reasonOf(new IOException()));
        assertEquals("odd thing", AccountRules.reasonOf(new IOException("java.io.IOException: odd thing.")));
        // a pin that changed wins over what it is wrapped in
        IOException wrapped = new IOException("outer", changed);
        assertEquals(PinnedTrust.CERTIFICATE_CHANGED, AccountRules.describe(wrapped).code);
        // not about the certificate: no code, and words that say what to check
        assertNull(AccountRules.describe(new SSLHandshakeException("Handshake failed")).code);
        assertTrue(AccountRules.describe(new SSLHandshakeException("Handshake failed")).message.contains("secure connection"));
        AccountRules.Failure absent = AccountRules.describe(new ConnectException("Connection refused"));
        assertNull(absent.code);
        assertTrue(absent.message, absent.message.contains("did not answer"));
        assertTrue(AccountRules.describe(new UnknownHostException("x")).message.contains("name was not found"));
        assertTrue(AccountRules.describe(new SocketTimeoutException("x")).message.contains("too long"));
        assertEquals("The request could not be made.", AccountRules.describe(new IOException()).message);
        assertEquals("odd", AccountRules.describe(new IOException("odd")).message);
        // a cause that is its own cause does not hang it
        IOException loop = new IOException("loops") {
            @Override
            public synchronized Throwable getCause() {
                return this;
            }
        };
        assertNull(AccountRules.describe(loop).code);
    }
}
