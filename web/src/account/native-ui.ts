// The account's dialogs in a native shell (the program on a computer, the app on a phone): the same account, reached another way (`native.ts`). Signing in is done in the person's own
// browser, so there is no password to type here: the app asks for the address of the server, sends the person to their browser, and waits. What is not done here (changing the password,
// downloading the data, deleting the account, ending other apps) is done in a browser, and the dialog says so.
import { h } from "../app/dom";
import { showDialog } from "../app/dialogs";
import { parseServer, SignInCancelled } from "./native";
import type { NativeAccount } from "./native";
import { AccountUi } from "./ui";

export class NativeAccountUi extends AccountUi {
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
    return this.account ? `Account (${this.account.email})…` : "Connect to an account server…";
  }

  override open(): Promise<void> {
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
    } catch {
      return;
    }
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
          this.account = await this.native.connect(String(values.server), (url) => {
            note.textContent = "Your browser was opened. Sign in there and allow the app, then come back here. If it did not open, open this address in a browser:";
            address.textContent = url;
            sentFor.hidden = false;
          });
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
    await showDialog({
      title: "Your account",
      body: [
        h("p", {}, "This app is signed in as ", h("strong", { text: account.email }), " on ", h("strong", { text: server.replace(/^https?:\/\//, "") }), "."),
        "A notebook is kept on the server only if you choose “Keep this notebook on the server…” for it. The others stay on this device.",
        `To change your password, download your data, delete the account, or sign out your other apps, open ${server} in a browser.`,
      ],
      confirm: "Close",
      noCancel: true,
      actions: [{ label: "Sign out of this app", run: (close) => (close(), void this.signOut()) }],
    });
  }

  override async signOut(): Promise<void> {
    const told = await this.native.disconnect();
    this.account = null;
    this.say(told ? "Signed out. Your notebooks on this device are as they were." : "Signed out on this device. The server could not be told: end this app's access from your account, in a browser.");
    this.changed();
  }
}
