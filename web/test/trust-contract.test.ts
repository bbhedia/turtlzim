// A server whose certificate the system does not know, trusted by its fingerprint (E17e): the page, the desktop program (Rust) and the Android app (Java) each have a part of it, and
// these are the places where they can drift apart without anything failing until someone connects a real server: the two codes of a refusal, the fingerprint that is compared (as the
// server announces it, as each side writes it), the certificates that the tests of both sides use, and what each side says about the way it checks.
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_CHANGED, CERTIFICATE_UNTRUSTED } from "../src/app/shell";
import { sameFingerprint } from "../src/account/native";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const rust = read("../../desktop/src-tauri/src/tls.rs");
const rustAccount = read("../../desktop/src-tauri/src/account.rs");
const shellScript = read("../../desktop/src-tauri/shell.js");
const java = read("../../mobile/android/app/src/main/java/org/zimnotebook/app/PinnedTrust.java");
const plugin = read("../../mobile/android/app/src/main/java/org/zimnotebook/app/ZimNativePlugin.java");
const mobileShell = read("../../mobile/shell/shell.ts");
const javaTest = read("../../mobile/android/app/src/test/java/org/zimnotebook/app/PinnedTrustTest.java");
const deviceTest = read("../../mobile/test/device.mjs");

// what `openssl x509 -noout -fingerprint -sha256` says of the two certificates that the tests of both sides run TLS servers with
const FP_A = "93:B9:5C:F3:A9:7D:EA:48:7F:20:8A:87:CA:FA:03:DB:E1:C3:50:85:3A:D7:A0:64:02:86:98:6D:5C:FF:F5:55";
const FP_B = "AA:5A:95:F1:7D:5A:44:04:6D:FD:8C:04:E4:F0:16:21:5C:57:E6:13:B6:D0:71:5E:EC:CA:65:ED:8E:DD:12:92";

describe("trusting a certificate that the system does not know", () => {
  it("is refused with the same two codes by the page, the program and the app", () => {
    expect(CERTIFICATE_UNTRUSTED).toBe("certificate-untrusted");
    expect(CERTIFICATE_CHANGED).toBe("certificate-changed");
    expect(rust).toContain(`pub const CERTIFICATE_UNTRUSTED: &str = "${CERTIFICATE_UNTRUSTED}";`);
    expect(rust).toContain(`pub const CERTIFICATE_CHANGED: &str = "${CERTIFICATE_CHANGED}";`);
    expect(java).toContain(`static final String CERTIFICATE_UNTRUSTED = "${CERTIFICATE_UNTRUSTED}";`);
    expect(java).toContain(`static final String CERTIFICATE_CHANGED = "${CERTIFICATE_CHANGED}";`);
    // (the program sends a failure as an object, and the script gives the page an error with the code; the app's plugin rejects with the code)
    expect(shellScript).toMatch(/error\.code \? \{ code: String\(error\.code\) \}/);
    expect(plugin).toContain("call.reject(failure.message, code)");
    // and the device test says them in the same words, for what the real plugin answers
    expect(deviceTest).toContain('"certificate-untrusted"');
    expect(deviceTest).toContain('"certificate-changed"');
  });

  it("compares the fingerprint that the server announces, as Node writes it, with the one that each side writes", () => {
    for (const [name, fingerprint] of [["a", FP_A], ["b", FP_B]] as const) {
      const desktop = read(`../../desktop/src-tauri/testdata/pin-${name}.pem`);
      // the same certificate on both sides, so that the two sides' tests are about the same thing
      expect(read(`../../mobile/android/app/src/test/resources/pin-${name}.pem`)).toBe(desktop);
      // (and the identity, with its key under a password: no key of the certificates is in the repository as text)
      expect(readFileSync(new URL(`../../mobile/android/app/src/test/resources/pin-${name}.p12`, import.meta.url)).equals(readFileSync(new URL(`../../desktop/src-tauri/testdata/pin-${name}.p12`, import.meta.url)))).toBe(true);
      expect(read(`../../desktop/src-tauri/testdata/pin-${name}.p12`)).not.toContain("PRIVATE KEY");
      // what the server's own console shows (`X509Certificate#fingerprint256`) is what each side shows and keeps
      expect(new X509Certificate(desktop).fingerprint256).toBe(fingerprint);
      expect(createHash("sha256").update(new X509Certificate(desktop).raw).digest("hex").toUpperCase().replace(/(..)(?=.)/g, "$1:")).toBe(fingerprint);
      expect(rust, name).toContain(`"${fingerprint}"`);
      expect(javaTest, name).toContain(`"${fingerprint}"`);
      expect(read("../../desktop/src-tauri/testdata/README.md"), name).toContain(fingerprint);
      // and the page takes it as the same however it is written
      expect(sameFingerprint(fingerprint, fingerprint.toLowerCase().replaceAll(":", " "))).toBe(true);
    }
    expect(FP_A).not.toBe(FP_B);
  });

  it("is checked in the handshake by each side, before anything is sent, and never falls back to what the system trusts", () => {
    // the program: the certificate is compared right after the handshake, on the connection that the request then goes over
    expect(rust).toMatch(/\/\/ \(the check that counts[^)]*\)\s+if Sha256::digest\(shown\(&stream\)\?\)\.as_slice\(\) != pin/);
    expect(rust).toContain("danger_accept_invalid_certs(true)");
    // (turned on in one place only: the connection that the certificate is then checked on)
    expect(rust.match(/danger_accept_invalid_certs/g)).toHaveLength(1);
    expect(rustAccount).toMatch(/if let Some\(pin\) = pin\.and_then\(tls::parse_fingerprint\)\.filter\(\|_\| url\.scheme\(\) == "https"\) \{\s+return tls::send_pinned/);
    // the app: the trust manager of a connection that has a certificate trusted for it takes that certificate and nothing else, and the one that takes anything is for looking only
    expect(java).toMatch(/static final class Pin implements X509TrustManager/);
    expect(java).toMatch(/private static final class Look implements X509TrustManager/);
    expect(java.match(/new Look\(\)/g)).toHaveLength(1);
    expect(plugin).toContain("new PinnedTrust.Pin(wanted)");
    expect(plugin).not.toContain("Look");
    // neither side lets the page say which certificate counts for a request: it is looked up from what was kept
    expect(shellScript).not.toMatch(/account_request[^)]*pin/);
    expect(mobileShell).not.toMatch(/request:[^\n]*(pin|fingerprint)/);
  });
});
