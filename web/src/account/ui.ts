// The account's dialogs: sign in, create an account (with the code that is e-mailed), the services, sign out, take the data away, delete, and the one that lets an app that
// was started on a computer or a phone use the account (the page it sends the person to). They only talk to the account client; what they know of the app is `say` (a line
// of the status bar) and `saveFile`.
import { h } from "../app/dom";
import { showDialog, showMessage } from "../app/dialogs";
import { APP_PARAMS, appKind, dropAppRequest, keepAppRequest, parseAppRequest, takeAppRequest } from "./app-request";
import type { AppRequest } from "./app-request";
import { AccountClient, ApiError, CONNECT_PROBLEMS, SIGN_IN_PROBLEMS } from "./client";
import type { Account, AppSession, Offer } from "./client";

const SERVICE_NAMES: Record<string, string> = { google: "Google", github: "GitHub" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AccountUi {
  /** What the server offers: null while not known and where there is no account server. */
  offer: Offer | null = null;
  account: Account | null = null;
  /** Told, once the dialog that did it is over, when who is signed in was changed by the person (signing in or out, an account made or deleted): what the screen says of the notebooks kept on it follows. */
  onChange: (() => void) | null = null;

  constructor(
    protected readonly say: (text: string) => void,
    private readonly saveFile: (fileName: string, blob: Blob) => void,
    readonly client = new AccountClient(),
  ) {}

  protected changed(): void {
    setTimeout(() => this.onChange?.(), 0);
  }

  /** Whether the menu has anything to say about accounts. */
  get available(): boolean {
    return this.offer !== null;
  }

  /** Whether what needs a browser's own windows (a service that is allowed in its own window, and sends the person back here) can be done from here: not in a native app. */
  get inBrowser(): boolean {
    return true;
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
    // (an app that was started on a computer or a phone sends the person here to be allowed: the request is in the address, or was kept while they signed in with a service)
    const appAsked = url.searchParams.has("app");
    const appRequest = appAsked ? parseAppRequest(url.searchParams) : signedIn !== null ? takeAppRequest() : null;
    if (!appRequest && problem === null) {
      if (appAsked || signedIn === null) dropAppRequest();
    } else if (problem !== null) dropAppRequest();
    const touched = problem !== null || signedIn !== null || connected !== null || connectProblem !== null || appAsked;
    if (touched) {
      for (const name of ["account_error", "signed_in", "connected", "connect_error", ...APP_PARAMS]) url.searchParams.delete(name);
      history_.replaceState(history_.state, "", url.pathname + (url.search || "") + url.hash);
    }
    if (!touched) return;
    if (appAsked && !appRequest) return this.say("That request from an app is not valid. Start it again from the app.");
    await this.refresh();
    if (problem !== null) this.say(SIGN_IN_PROBLEMS[problem] ?? SIGN_IN_PROBLEMS.failed!);
    else if (signedIn !== null && this.account) this.say(`Signed in as ${this.account.email}.`);
    else if (connectProblem !== null) this.say(CONNECT_PROBLEMS[connectProblem] ?? CONNECT_PROBLEMS.failed!);
    else if (connected !== null) this.say("The service is connected. Choose it in “Keep this notebook on the server…”.");
    if (appRequest && problem === null) await this.allowApp(appRequest);
  }

  /**
   * An app asks to use the account. The person signs in here if they are not (with a service, the page leaves and comes back to `start`, which goes on from the request that was kept),
   * and is asked, plainly, whether to allow it; the answer is the app's own return address with a code, which this page then goes to.
   */
  private async allowApp(request: AppRequest): Promise<void> {
    if (!this.account) {
      // (kept while the person signs in: with a service, the page leaves, and comes back to `start`, which takes the request from here)
      keepAppRequest(request);
      this.say("Sign in to allow the app that asked.");
      await this.signInDialog();
      if (!this.account) return;
      dropAppRequest();
    }
    const account = this.account;
    const kind = appKind(request.redirectUri);
    const what = kind === "android" ? "The Zim Notebook app on an Android phone or tablet" : kind === "ios" ? "The Zim Notebook app on an iPhone or iPad" : "The Zim Notebook program on a computer";
    let back: string | null = null;
    await showDialog({
      title: "Allow this app?",
      body: [
        h("p", {}, what, " is asking to use your account ", h("strong", { text: account.email }), "."),
        "It will be able to keep your notebooks on this server, as this page can. It will not be able to change your password, delete your account or download your data.",
        "Allow it only if you have just asked that app to connect. You can sign it out later, from your account.",
      ],
      confirm: "Allow",
      working: "Allowing…",
      focus: "cancel",
      submit: async () => {
        try {
          back = (await this.client.authorizeApp({ redirect_uri: request.redirectUri, code_challenge: request.challenge, code_challenge_method: "S256", state: request.state })).redirect;
        } catch (error) {
          return this.explain(error);
        }
      },
    });
    dropAppRequest();
    if (!back) return this.say("The app was not allowed. You can close this page.");
    const url: string = back;
    // (a phone's browser may only go to an app's own address when a link is pressed: the link is there for that, and the page goes on its own where it may)
    window.setTimeout(() => window.location.assign(url), 0);
    await showMessage("Allowed", "The app was allowed. This page is taking you back to it. If nothing happens, press the link below, then close this page.", h("p", {}, h("a", { class: "service-link", href: url, text: "Go back to the app" })));
  }

  /** Ask the server what it offers and who is signed in (a server that doesn't answer is no account server: nothing is shown). */
  async refresh(): Promise<void> {
    const offer = await this.client.offer();
    // (a server that can't be reached right now is not a server that is not there: what was known of the account stays, so that a notebook that is kept elsewhere does not look as if it were not)
    if (!offer) {
      if (!this.account) this.offer = null;
      return;
    }
    this.offer = offer;
    try {
      this.account = await this.client.me();
    } catch {
      // (the same: nobody is signed out because the network is down)
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
        this.changed();
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
        this.changed();
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
    let next: "delete" | "apps" | null = null;
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
        { label: "Connected apps…", run: (close) => ((next = "apps"), close()) },
        { label: "Download my data", run: () => void this.download() },
        { label: "Delete the account…", run: (close) => ((next = "delete"), close()) },
      ],
    });
    if (next === "delete") await this.deleteDialog();
    else if (next === "apps") await this.appsDialog();
  }

  /** The apps that were signed in to the account (the program on a computer, the app on a phone), each with the way to sign it out: what to do about a phone that was lost. */
  private async appsDialog(): Promise<void> {
    let apps: AppSession[];
    try {
      apps = await this.client.listApps();
    } catch (error) {
      this.say(`Couldn't list the apps: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const list = h("ul", { class: "app-list" });
    const empty = h("p", { class: "field-hint", text: "No app is connected: the program on a computer or the app on a phone, when you connect one, is listed here." });
    const draw = () => {
      list.replaceChildren(
        ...apps.map((app) => {
          const button = h("button", { type: "button", class: "secondary", text: "Sign out", "aria-label": `Sign out ${app.label}, connected ${day(app.connectedAt)}` });
          button.addEventListener("click", () => {
            button.disabled = true;
            this.client.revokeApp(app.id).then(
              () => {
                apps = apps.filter((a) => a.id !== app.id);
                draw();
              },
              (error: unknown) => {
                button.disabled = false;
                this.say(`Couldn't sign it out: ${error instanceof Error ? error.message : String(error)}`);
              },
            );
          });
          return h("li", {}, h("span", {}, h("strong", { text: app.label }), ` — connected ${day(app.connectedAt)}, last used ${day(app.lastUsed)}`), button);
        }),
      );
      empty.hidden = apps.length > 0;
    };
    draw();
    await showDialog({ title: "Connected apps", body: ["These apps can keep your notebooks on the server. Sign out one that you don't use any more, or one that was lost.", list, empty], confirm: "Close", noCancel: true });
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
    this.changed();
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
        this.changed();
      },
    });
  }

  /** A failure as a line for a dialog (the server's own words are written for a person; a wait is said with its time). */
  protected explain(error: unknown): string {
    if (error instanceof ApiError) return error.status === 429 && error.retryAfter ? `Too many tries. Wait ${Math.ceil(error.retryAfter / 60)} minute(s) and try again.` : error.message;
    return error instanceof Error ? error.message : String(error);
  }
}
