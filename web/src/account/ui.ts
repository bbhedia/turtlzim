// The account's dialogs: sign in, create an account (with the code that is e-mailed), the services, sign out, take the data away, delete. They only
// talk to the account client; what they know of the app is `say` (a line of the status bar) and `saveFile`.
import { h } from "../app/dom";
import { showDialog } from "../app/dialogs";
import { AccountClient, ApiError, CONNECT_PROBLEMS, SIGN_IN_PROBLEMS } from "./client";
import type { Account, Offer } from "./client";

const SERVICE_NAMES: Record<string, string> = { google: "Google", github: "GitHub" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AccountUi {
  /** What the server offers: null while not known and where there is no account server. */
  offer: Offer | null = null;
  account: Account | null = null;

  constructor(
    private readonly say: (text: string) => void,
    private readonly saveFile: (fileName: string, blob: Blob) => void,
    readonly client = new AccountClient(),
  ) {}

  /** Whether the menu has anything to say about accounts. */
  get available(): boolean {
    return this.offer !== null;
  }

  /**
   * Deal with what a sign-in service's return trip left in the address. Nothing is asked of the network otherwise, until the person opens the menu (`refresh`):
   * a page that starts from its saved copy with the server gone, or on a static host, makes no request that it has no use for yet.
   */
  async start(location: Location = window.location, history_: History = history): Promise<void> {
    const url = new URL(location.href);
    const problem = url.searchParams.get("account_error");
    const signedIn = url.searchParams.get("signed_in");
    const connected = url.searchParams.get("connected");
    const connectProblem = url.searchParams.get("connect_error");
    if (problem !== null || signedIn !== null || connected !== null || connectProblem !== null) {
      for (const name of ["account_error", "signed_in", "connected", "connect_error"]) url.searchParams.delete(name);
      history_.replaceState(history_.state, "", url.pathname + (url.search || "") + url.hash);
    }
    if (problem === null && signedIn === null && connected === null && connectProblem === null) return;
    await this.refresh();
    if (problem !== null) this.say(SIGN_IN_PROBLEMS[problem] ?? SIGN_IN_PROBLEMS.failed!);
    else if (signedIn !== null && this.account) this.say(`Signed in as ${this.account.email}.`);
    else if (connectProblem !== null) this.say(CONNECT_PROBLEMS[connectProblem] ?? CONNECT_PROBLEMS.failed!);
    else if (connected !== null) this.say("The service is connected. Choose it in “Keep this notebook on the server…”.");
  }

  /** Ask the server what it offers and who is signed in (a server that doesn't answer is no account server: nothing is shown). */
  async refresh(): Promise<void> {
    this.offer = await this.client.offer();
    this.account = null;
    if (!this.offer) return;
    try {
      this.account = await this.client.me();
    } catch {
      this.account = null;
    }
  }

  /** The menu's line, and what it does. */
  get menuLabel(): string {
    return this.account ? `Account (${this.account.email})…` : "Sign in or create an account…";
  }
  open(): Promise<void> {
    return this.account ? this.accountDialog() : this.signInDialog();
  }

  private serviceButtons(): HTMLElement | null {
    const providers = this.offer?.providers ?? [];
    if (providers.length === 0) return null;
    return h("div", { class: "account-services" }, ...providers.map((name) => h("a", { class: "service-link", href: `/api/oauth/${name}/start`, text: `Continue with ${SERVICE_NAMES[name] ?? name}` })), h("p", { class: "field-hint", text: "or with your e-mail address:" }));
  }

  private async signInDialog(email = ""): Promise<void> {
    let next: "create" | "forgot" | null = null;
    const done = await showDialog({
      title: "Sign in",
      body: [this.serviceButtons(), h("p", { class: "field-hint", text: "An account is optional: without one, your notebooks stay on this device as before." })].filter((c) => c !== null),
      fields: [
        { name: "email", label: "E-mail address", value: email, validate: (v) => (EMAIL.test(v.trim()) ? null : "Enter your e-mail address.") },
        { name: "password", label: "Password", type: "password", autocomplete: "current-password", validate: (v) => (v ? null : "Enter your password.") },
      ],
      confirm: "Sign in",
      working: "Signing in…",
      actions: [
        { label: "Create an account…", run: (close) => ((next = "create"), close()) },
        { label: "Forgot the password…", run: (close) => ((next = "forgot"), close()) },
      ],
      submit: async (values) => {
        try {
          this.account = await this.client.login(String(values.email).trim(), String(values.password));
        } catch (error) {
          if (error instanceof ApiError && error.code === "unconfirmed") {
            next = null;
            queueMicrotask(() => void this.codeDialog(String(values.email).trim()));
            return undefined;
          }
          return this.explain(error);
        }
        this.say(`Signed in as ${this.account.email}.`);
      },
    });
    if (!done && next === "create") await this.createDialog(email);
    else if (!done && next === "forgot") await this.forgotDialog();
  }

  private async createDialog(email = ""): Promise<void> {
    let created: string | null = null;
    let back = false;
    await showDialog({
      title: "Create an account",
      body: [this.serviceButtons(), h("p", { class: "field-hint", text: "A code is sent to your e-mail address to confirm it, once, now. Signing in afterwards needs only the password." })].filter((c) => c !== null),
      fields: [
        { name: "email", label: "E-mail address", value: email, validate: (v) => (EMAIL.test(v.trim()) ? null : "Enter an e-mail address.") },
        { name: "password", label: "Password", type: "password", autocomplete: "new-password", hint: "At least 10 characters.", validate: (v) => (v.length >= 10 ? null : "At least 10 characters.") },
      ],
      confirm: "Send me the code",
      working: "Sending…",
      actions: [{ label: "I have an account", run: (close) => ((back = true), close()) }],
      submit: async (values) => {
        try {
          await this.client.register(String(values.email).trim(), String(values.password));
        } catch (error) {
          return this.explain(error);
        }
        created = String(values.email).trim();
      },
    });
    if (created) await this.codeDialog(created);
    else if (back) await this.signInDialog(email);
  }

  /** The code that was e-mailed: it confirms the address and signs the person in. */
  private async codeDialog(email: string): Promise<void> {
    await showDialog({
      title: "Enter the code",
      body: [`A 6-digit code was sent to ${email} (if it is not there in a minute, look in the spam folder). It is good for 10 minutes.`],
      fields: [{ name: "code", label: "Code", autocomplete: undefined, placeholder: "123456", validate: (v) => (/^\d{6}$/.test(v.trim()) ? null : "Six digits.") }],
      confirm: "Confirm",
      working: "Checking…",
      actions: [
        {
          label: "Send it again",
          run: () => {
            this.client.resend(email).then(
              () => this.say("If the address is waiting for a code, a new one was sent."),
              (error: unknown) => this.say(error instanceof Error ? error.message : String(error)),
            );
          },
        },
      ],
      submit: async (values) => {
        try {
          this.account = await this.client.verify(email, String(values.code).trim());
        } catch (error) {
          return this.explain(error);
        }
        this.say(`Account created. Signed in as ${this.account.email}.`);
      },
    });
  }

  private async forgotDialog(): Promise<void> {
    let sent: string | null = null;
    await showDialog({
      title: "Forgot the password",
      body: ["A code to choose a new password is sent to the address of your account. (Notes that you encrypt with a passphrase can't be recovered by this: nobody can.)"],
      fields: [{ name: "email", label: "E-mail address", validate: (v) => (EMAIL.test(v.trim()) ? null : "Enter your e-mail address.") }],
      confirm: "Send me the code",
      working: "Sending…",
      submit: async (values) => {
        try {
          await this.client.forgot(String(values.email).trim());
        } catch (error) {
          return this.explain(error);
        }
        sent = String(values.email).trim();
      },
    });
    if (!sent) return;
    const email: string = sent;
    await showDialog({
      title: "Choose a new password",
      body: [`If ${email} has an account, a 6-digit code was sent to it.`],
      fields: [
        { name: "code", label: "Code", validate: (v) => (/^\d{6}$/.test(v.trim()) ? null : "Six digits.") },
        { name: "password", label: "New password", type: "password", autocomplete: "new-password", validate: (v) => (v.length >= 10 ? null : "At least 10 characters.") },
      ],
      confirm: "Change the password",
      working: "Changing…",
      submit: async (values) => {
        try {
          await this.client.reset(email, String(values.code).trim(), String(values.password));
        } catch (error) {
          return this.explain(error);
        }
        this.say("The password was changed. Sign in with it.");
      },
    });
  }

  private async accountDialog(): Promise<void> {
    const account = this.account;
    if (!account) return;
    const services = account.signIns.map((s) => SERVICE_NAMES[s] ?? s);
    let next: "delete" | null = null;
    await showDialog({
      title: "Your account",
      body: [
        h("p", {}, "Signed in as ", h("strong", { text: account.email }), "."),
        `Signs in with: ${[account.hasPassword ? "password" : null, ...services].filter(Boolean).join(", ") || "—"}.`,
        `Space on the server: ${Math.round(account.quotaBytes / 1024)} KB for your notes once they can be kept there. Today your notebooks stay on this device: nothing of them is sent.`,
      ],
      confirm: "Close",
      noCancel: true,
      actions: [
        { label: "Sign out", run: (close) => (close(), void this.signOut()) },
        { label: "Download my data", run: () => void this.download() },
        { label: "Delete the account…", run: (close) => ((next = "delete"), close()) },
      ],
    });
    if (next === "delete") await this.deleteDialog();
  }

  async signOut(): Promise<void> {
    try {
      await this.client.logout();
    } catch (error) {
      this.say(`Couldn't sign out: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.account = null;
    this.say("Signed out. Your notebooks on this device are as they were.");
  }

  private async download(): Promise<void> {
    try {
      this.saveFile("zim-notebook-account.json", new Blob([await this.client.exportData()], { type: "application/json" }));
    } catch (error) {
      this.say(`Couldn't download: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async deleteDialog(): Promise<void> {
    const account = this.account;
    if (!account) return;
    await showDialog({
      title: "Delete the account",
      body: [`This deletes the account ${account.email} on the server, for good. Notebooks on this device are not touched.`, account.hasPassword ? "Type your password to confirm." : "You signed in with a service: sign in again first if it was more than 10 minutes ago."],
      fields: account.hasPassword ? [{ name: "password", label: "Password", type: "password", autocomplete: "current-password", validate: (v) => (v ? null : "Enter your password.") }] : [],
      confirm: "Delete the account",
      working: "Deleting…",
      danger: true,
      submit: async (values) => {
        try {
          await this.client.deleteAccount(String(values.password ?? ""));
        } catch (error) {
          return this.explain(error);
        }
        this.account = null;
        this.say("The account was deleted.");
      },
    });
  }

  /** A failure as a line for a dialog (the server's own words are written for a person; a wait is said with its time). */
  private explain(error: unknown): string {
    if (error instanceof ApiError) return error.status === 429 && error.retryAfter ? `Too many tries. Wait ${Math.ceil(error.retryAfter / 60)} minute(s) and try again.` : error.message;
    return error instanceof Error ? error.message : String(error);
  }
}
