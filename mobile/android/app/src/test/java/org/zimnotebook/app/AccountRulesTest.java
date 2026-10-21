package org.zimnotebook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

/** The rules of what the app asks of the network (AccountRules), as the desktop program's tests state them (desktop/src-tauri/src/account.rs). */
public class AccountRulesTest {
    private static void refused(String raw) {
        try {
            AccountRules.checkUrl(raw);
            fail("was not refused: " + raw);
        } catch (AccountRules.Refused expected) {
            assertFalse(expected.getMessage().isEmpty());
        }
    }

    @Test
    public void onlyAServerThatCanBeTrustedWithATokenIsAsked() throws Exception {
        for (String good : new String[] {
            "https://notes.example.org/api/me",
            "https://notes.example.org:8443/api/sync/notebooks?x=1",
            "http://127.0.0.1:8080/api/me",
            "http://localhost:3000/api/me",
            "http://[::1]:8080/api/me",
            "http://127.0.0.2:80/api/me",
            "HTTPS://Notes.Example.org/api/me",
            "https://notes.example.org/api/./me",
            "https://notes.example.org/api/a%2eb",
        }) {
            assertEquals(good, good, AccountRules.checkUrl(good).toString());
        }
        for (String bad : new String[] {
            "http://notes.example.org/api/me",
            "http://192.168.1.10/api/me",
            "http://127.0.0.1.example.org/api/me",
            "http://localhost.example.org/api/me",
            "http://128.0.0.1/api/me",
            "http://127.0.0.256/api/me",
            "ftp://notes.example.org/api/me",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://ada:secret@notes.example.org/api/me",
            "https://ada@notes.example.org/api/me",
            "http://127.0.0.1@evil.example/api/me",
            "https://notes.example.org/other",
            "https://notes.example.org/api",
            "https://notes.example.org/apix/me",
            "https://notes.example.org/api/me#x",
            "https://notes.example.org/api/../etc/passwd",
            // a dot segment written in percent: the client's parser resolves it, so the request would leave /api/
            "https://notes.example.org/api/%2e%2e/etc/passwd",
            "https://notes.example.org/api/%2E%2E/etc/passwd",
            "https://notes.example.org/api/.%2e/etc/passwd",
            "https://notes.example.org/api/%2e./etc/passwd",
            "https://notes.example.org/api/x/%2e%2e/%2e%2e/y",
            "https://notes.example.org/api/%2e%2e",
            // an address that the client cannot read at all (a port that is no port)
            "https://notes.example.org:99999/api/me",
            "not an address",
            "",
        }) {
            refused(bad);
        }
        refused(null);
    }

    @Test
    public void aCertificateIsTrustedForAServerAndNotForAPageOfItOrForAnAddressThatIsNotHttps() throws Exception {
        for (String good : new String[] { "https://notes.example.org", "https://notes.example.org:8443", "https://notes.example.org:8443/", "https://192.168.10.10:8443", "https://[::1]:8443", "HTTPS://Notes.Example.org" }) AccountRules.checkOrigin(good);
        for (String bad : new String[] { "http://notes.example.org", "http://127.0.0.1:8080", "ftp://notes.example.org", "https://ada:secret@notes.example.org", "https://ada@notes.example.org", "https://notes.example.org/api/me", "https://notes.example.org/?x=1", "https://notes.example.org/#x", "https://", "not an address", "" }) {
            try {
                AccountRules.checkOrigin(bad);
                fail("was not refused: " + bad);
            } catch (AccountRules.Refused expected) {
                assertFalse(expected.getMessage().isEmpty());
            }
        }
        try {
            AccountRules.checkOrigin(null);
            fail("null was not refused");
        } catch (AccountRules.Refused expected) {
            // as it should be
        }
        // the key is the origin, the port always written, so that one server is one key whichever way its address was typed
        assertEquals("https://notes.example.org:443", AccountRules.originKey(AccountRules.checkOrigin("https://Notes.Example.org/")));
        assertEquals("https://notes.example.org:443", AccountRules.originKey(AccountRules.checkOrigin("https://notes.example.org:443")));
        assertEquals("https://notes.example.org:8443", AccountRules.originKey(AccountRules.checkOrigin("https://notes.example.org:8443")));
        assertEquals("https://192.168.10.10:8443", AccountRules.originKey(AccountRules.checkOrigin("https://192.168.10.10:8443")));
        assertEquals("https://[::1]:8443", AccountRules.originKey(AccountRules.checkOrigin("https://[::1]:8443")));
        // and the address of a request has the same key as the origin that its server was trusted under
        assertEquals("https://notes.example.org:8443", AccountRules.originKey(okhttp3.HttpUrl.parse("https://notes.example.org:8443/api/sync/x?y=1")));
    }

    @Test
    public void theBrowserIsSentOnlyWhereAPersonWouldGo() throws Exception {
        for (String good : new String[] { "https://notes.example.org/?app=authorize&state=x", "http://127.0.0.1:8080/?app=authorize", "http://localhost:3000/" }) {
            AccountRules.checkBrowserUrl(good);
        }
        for (String bad : new String[] { "http://notes.example.org/", "file:///etc/passwd", "javascript:alert(1)", "ftp://notes.example.org/", "https://ada:secret@notes.example.org/", "mailto:a@b.c", "org.zimnotebook.app:/callback", "https://", "" }) {
            try {
                AccountRules.checkBrowserUrl(bad);
                fail("was not refused: " + bad);
            } catch (AccountRules.Refused expected) {
                // as it should be
            }
        }
    }

    @Test
    public void aRequestCarriesTheHeadersOfAnAppAndNoOthers() {
        for (String name : new String[] { "Authorization", "content-type", "X-Requested-With", "ACCEPT" }) assertTrue(name, AccountRules.forwards(name));
        for (String name : new String[] { "cookie", "Origin", "referer", "x-made-up", "host", "content-length", "" }) assertFalse(name, AccountRules.forwards(name));
        assertTrue(AccountRules.METHODS.contains("PATCH"));
        assertFalse(AccountRules.METHODS.contains("TRACE"));
    }

    @Test
    public void aSecretsNameIsNotAPath() {
        assertTrue(AccountRules.validSecretName("account-token"));
        for (String bad : new String[] { "", "a/b", "../x", ".hidden", "a b", "a.b", "a".repeat(65) }) assertFalse(bad, AccountRules.validSecretName(bad));
        assertFalse(AccountRules.validSecretName(null));
    }
}
