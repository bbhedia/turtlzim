// The account's dialogs in a native shell (the program on a computer, the app on a phone): the same account, reached another way (`native.ts`). Signing in is done in the person's own
// browser, so there is no password to type here: the app asks for the address of the server, sends the person to their browser, and waits. What is not done here (changing the password,
// downloading the data, deleting the account, ending other apps) is done in a browser, and the dialog says so.
import { h } from "../app/dom";
import { showDialog, showMessage } from "../app/dialogs";
import { CERTIFICATE_CHANGED, CERTIFICATE_UNTRUSTED } from "../app/shell";
import type { CertificateInfo } from "../app/shell";
import { ApiError } from "./client";
import { parseServer, sameFingerprint, SignInCancelled } from "./native";
import type { CertificateKind, CertificateQuestion, NativeAccount } from "./native";
import { AccountUi } from "./ui";

/**
 * A fingerprint, to be read and compared with another: set apart, in a fixed-width face, and easy to select whole. It may go over two lines, but only between two pairs of digits (a break
 * opportunity after each colon, and nowhere else): a pair that is split over two lines is read wrong.
 */
function fingerprintOf(fingerprint: string): HTMLElement {
  const pairs = fingerprint.split(":");
  return h("code", { class: "fingerprint" }, ...pairs.flatMap((pair, index) => (index < pairs.length - 1 ? [`${pair}:`, h("wbr")] : [pair])));
}

/** What a certificate says of itself, as a line (the parts that the shell could read), or nothing. */
function describeCertificate(info: CertificateInfo): HTMLElement | null {
  const parts: string[] = [];
  if (info.names?.length) parts.push(`for ${info.names.slice(0, 6).join(", ")}${info.names.length > 6 ? "…" : ""}`);
  if (info.issuer) parts.push(info.subject && info.subject === info.issuer ? "signed by itself" : `made by ${info.issuer}`);
  if (info.notAfter !== undefined && Number.isFinite(info.notAfter)) parts.push(`${info.notAfter < Date.now() ? "expired on" : "valid until"} ${new Date(info.notAfter).toISOString().slice(0, 10)}`);
  return parts.length ? h("p", { class: "field-hint", text: `The certificate says it is ${parts.join(", ")}.` }) : null;
}

export class NativeAccountUi extends AccountUi {
  /** Whether the server's last answer was refused for the sake of its certificate (and why): the menu then leads to the certificate, which is what there is to do. */
  private certificateKind: CertificateKind | null = null;
  /** Whether the person was told about it (the account is asked about each time the menu opens: it is said once). */
  private certificateTold = false;

  constructor(
    say: (text: string) => void,
    saveFile: (fileName: string, blob: Blob) => void,
    private readonly native: NativeAccount,
  ) {
    super(say, saveFile, native.client);
  }

  /** A shell that can reach a server always has something to say about accounts: where there is none yet, how to connect to one. */
  override get available(): boolean {
    return true;
  }

  override get inBrowser(): boolean {
    return false;
  }

  override get menuLabel(): string {
    return this.account ? `Account (${this.account.email})…` : this.certificateKind ? "The server's certificate…" : "Connect to an account server…";
  }

  override open(): Promise<void> {
    if (this.certificateKind && !this.account) return this.reviewCertificate();
    return this.account ? this.nativeAccountDialog() : this.connectDialog();
  }

  /** At the start: if this app was connected, who it is connected as (`refresh` asks nothing when it was not; the shell has nothing to say about an address's return trip). */
  override async start(): Promise<void> {
    await this.refresh();
  }

  /**
   * Who this app is signed in as. A server that can't be reached now leaves what was known as it was; one that does not know the token any more (it was ended from the account, or the
   * password was changed) makes this app signed out, and says so.
   */
  override async refresh(): Promise<void> {
    if (!this.native.server || !(await this.native.hasToken())) {
      this.account = null;
      return;
    }
    let me;
    try {
      me = await this.client.me();
    } catch (error) {
      // (a certificate that the server shows and that this device will not take is not a server that is down: it is told, once, with where to go)
      const code = error instanceof ApiError ? error.code : undefined;
      this.certificateKind = code === CERTIFICATE_CHANGED ? "changed" : code === CERTIFICATE_UNTRUSTED ? "new" : null;
      if (this.certificateKind && !this.certificateTold) {
        this.certificateTold = true;
        this.say(this.certificateKind === "changed" ? "The server's certificate is not the one you trusted. Open the account menu to look at it." : "This device does not trust the server's certificate. Open the account menu to look at it.");
      }
      return;
    }
    this.certificateKind = null;
    this.certificateTold = false;
    if (me === null) {
      await this.native.forgetToken();
      if (this.account) this.say("The server signed this app out (it was ended from the account, or the password was changed). Connect again to keep notebooks in step.");
      this.account = null;
      this.changed();
      return;
    }
    this.account = me;
  }

  /** The address of the server, then the person's own browser, and the wait. Cancel stops the wait at once. */
  private async connectDialog(): Promise<void> {
    const note = h("p", { class: "field-hint" });
    const address = h("code", { class: "wait-address" });
    const sentFor = h("div", { hidden: true }, note, address);
    const problem = (value: string): string | null => {
      const parsed = parseServer(value);
      return "problem" in parsed ? parsed.problem : null;
    };
    await showDialog({
      title: "Connect to an account server",
      body: [
        "An account keeps your notebooks in step between your devices. You sign in in your own browser: this app never sees your password, and keeps only a token that you can end from your account.",
        "The account is optional: without it, notebooks stay on this device.",
        sentFor,
      ],
      fields: [{ name: "server", label: "Address of the server", value: this.native.suggested, placeholder: "https://notes.example.org", select: "all", validate: (v) => problem(v) }],
      confirm: "Continue in the browser",
      working: "Waiting for the browser…",
      abort: () => this.native.cancel(),
      submit: async (values) => {
        try {
          this.account = await this.native.connect(
            String(values.server),
            (url) => {
              note.textContent = "Your browser was opened. Sign in there and allow the app, then come back here. If it did not open, open this address in a browser:";
              address.textContent = url;
              sentFor.hidden = false;
            },
            (question) => this.askCertificate(question),
          );
        } catch (error) {
          if (error instanceof SignInCancelled) return undefined;
          return this.explain(error);
        }
        this.say(`Connected to ${this.native.server} as ${this.account.email}.`);
        this.changed();
        return undefined;
      },
    });
  }

  private async nativeAccountDialog(): Promise<void> {
    const account = this.account;
    if (!account) return;
    const server = this.native.server ?? "";
    const trusted = await this.native.pinned();
    // (the server's last answer was refused for the sake of its certificate: nothing is sent to it until the person has looked, and that is what this dialog leads to first)
    const refused = this.certificateKind;
    const looks = await showDialog({
      title: "Your account",
      body: [
        h("p", {}, "This app is signed in as ", h("strong", { text: account.email }), " on ", h("strong", { text: server.replace(/^https?:\/\//, "") }), "."),
        ...(refused
          ? [refused === "changed" ? "The server now shows a certificate other than the one you trusted, so nothing is sent to it until you have looked at the new one." : "This device does not trust the server's certificate, so nothing is sent to it until you have looked at it."]
          : []),
        ...(trusted
          ? [h("p", {}, refused ? "The certificate that you trusted for this server:" : "This device does not know who made the server's certificate: it talks to this server because you trusted this one, and only while the server shows it. Its fingerprint:", fingerprintOf(trusted))]
          : []),
        "A notebook is kept on the server only if you choose “Keep this notebook on the server…” for it. The others stay on this device.",
        `To change your password, download your data, delete the account, or sign out your other apps, open ${server} in a browser.`,
      ],
      confirm: refused ? "Look at the certificate…" : "Close",
      noCancel: !refused,
      actions: [
        ...(trusted && !refused ? [{ label: "Look at the certificate…", run: (close: () => void) => (close(), void this.reviewCertificate()) }] : []),
        { label: "Sign out of this app", run: (close: () => void) => (close(), void this.signOut()) },
      ],
    });
    if (looks && refused) await this.reviewCertificate();
  }

  /**
   * Put a certificate to the person: one that the system does not know and that nothing was trusted for (the first time), or one that is not the one they trusted (it changed). The fingerprint
   * is what they compare, with the one the server's own screen or log shows; Cancel has the focus, so that a stray Enter does not trust anything.
   */
  private askCertificate({ info, kind, previous, reason, server }: CertificateQuestion): Promise<boolean> {
    const host = server.replace(/^https:\/\//, "");
    const details = describeCertificate(info);
    const body =
      kind === "changed"
        ? [
            h("p", {}, h("strong", { text: host }), " now shows a different certificate from the one you trusted for it."),
            "This is normal if whoever runs the server made the certificate again (that is done about once a year). It is also what it would look like if someone were intercepting the connection. Compare the new fingerprint with the one that the server's own screen or log shows, and trust it only if they are exactly the same.",
            h("p", {}, "The new certificate:", fingerprintOf(info.fingerprint)),
            ...(details ? [details] : []),
            ...(previous ? [h("p", {}, "The one you trusted before:", fingerprintOf(previous))] : []),
          ]
        : [
            h("p", {}, h("strong", { text: host }), " showed a certificate that this device does not know, so it can't tell whether this is your server or something between you and it."),
            ...(reason ? [h("p", { class: "field-hint", text: reason })] : []),
            "Compare this fingerprint with the one that your server's own screen or log shows (it is shown when the server starts). Trust the certificate only if they are exactly the same.",
            fingerprintOf(info.fingerprint),
            ...(details ? [details] : []),
            "If you trust it, this app talks to this address only while the server shows this very certificate, and asks you again if it ever shows another. Your browser will probably warn about the same certificate when it opens the server's page for you to sign in: its certificate viewer shows the fingerprint too.",
          ];
    return showDialog({
      title: kind === "changed" ? "The server's certificate has changed" : "Trust this server's certificate?",
      body,
      confirm: kind === "changed" ? "Trust the new certificate" : "Trust this certificate",
      focus: "cancel",
    });
  }

  /** Look at what the server shows now; put it to the person if it is not the certificate they trusted (or if none was trusted and the system does not know it). */
  private async reviewCertificate(): Promise<void> {
    const server = this.native.server;
    if (!server) return;
    let info: CertificateInfo;
    try {
      info = await this.native.inspect(server);
    } catch (error) {
      await showMessage("The certificate can't be looked at", this.explain(error));
      return;
    }
    const previous = await this.native.pinned(server);
    if (previous !== null && sameFingerprint(previous, info.fingerprint)) {
      await showMessage("This is the certificate you trusted", "The server shows the same certificate as the one you trusted for it. Its fingerprint:", fingerprintOf(info.fingerprint));
      return;
    }
    const yes = await this.askCertificate({ info, kind: previous === null ? "new" : "changed", previous, reason: "", server });
    if (!yes) return;
    try {
      await this.native.trust(server, info);
    } catch (error) {
      await showMessage("The certificate was not trusted", this.explain(error));
      return;
    }
    // (the server is asked again with what is trusted now: who is signed in comes back, and what was said of the certificate is no longer true: `refresh` forgets it)
    await this.refresh();
    this.changed();
    if (this.account) this.say(`Connected to ${server} as ${this.account.email}.`);
  }

  override async signOut(): Promise<void> {
    const told = await this.native.disconnect();
    this.account = null;
    this.say(told ? "Signed out. Your notebooks on this device are as they were." : "Signed out on this device. The server could not be told: end this app's access from your account, in a browser.");
    this.changed();
  }
}
