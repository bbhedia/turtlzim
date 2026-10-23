// An account from a native shell (src/account/native.ts, native-ui.ts, app-request.ts): what the app asks of the shell, what it shows of the server's answers, what it keeps and where.
// The server is a stand-in that keeps to the contract of server/src/apps.mjs (the real one is tried with this client in the browser scenario, and from the server's own side by its tests);
// the shell's hooks are made up here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_CHANGED, CERTIFICATE_UNTRUSTED } from "../src/app/shell";
import type { AccountHooks, CertificateInfo, NetRequest, NetResponse, SignInResult } from "../src/app/shell";
import { APP_PARAMS, appKind, keepAppRequest, parseAppRequest, takeAppRequest } from "../src/account/app-request";
import { ApiError, TransportError } from "../src/account/client";
import { CertificateRefused, challengeOf, NativeAccount, parseServer, randomToken, SERVER_SETTING, sameFingerprint, SignInCancelled } from "../src/account/native";
import type { CertificateQuestion } from "../src/account/native";
import { NativeAccountUi } from "../src/account/native-ui";

const SERVER = "https://notes.example.org";
const REDIRECT = "http://127.0.0.1:49152/callback";

const json = (status: number, body: unknown): NetResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bearerOf = (request: NetRequest) => /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;

/** What the real server does for an app, as far as the client can tell: PKCE checked with its own SHA-256, a code good once, a token that works until it is ended. */
class StandInServer {
  log: NetRequest[] = [];
  tokens = new Set<string>();
  challenge = "";
  redirect = "";
  codesLeft = new Set<string>();
  /** What to answer to `/api/providers` instead of the server's own answer. */
  providers: NetResponse | null = null;
  /** The server can't be reached (or its certificate is not trusted): every request fails with this. */
  down: Error | null = null;

  request = async (request: NetRequest): Promise<NetResponse> => {
    this.log.push(request);
    const url = new URL(request.url);
    if (url.origin !== SERVER) throw new Error(`a request went to ${url.origin}`);
    if (this.down) throw this.down;
    switch (url.pathname) {
      case "/api/providers":
        return this.providers ?? json(200, { providers: ["github"], email: true });
      case "/api/app/token": {
        const body = JSON.parse(request.body ?? "{}") as { code?: string; code_verifier?: string; redirect_uri?: string };
        const mine = body.code && this.codesLeft.delete(body.code);
        const proven = createHash("sha256").update(body.code_verifier ?? "").digest("base64url") === this.challenge;
        if (!mine || !proven || body.redirect_uri !== this.redirect) return json(400, { error: "That sign-in did not work, or took too long. Start it again from the app.", code: "bad-grant" });
        const token = `token-${this.tokens.size + 1}-${"x".repeat(40)}`;
        this.tokens.add(token);
        return json(200, { token, user: { email: "ada@example.org", quotaBytes: 1048576, hasPassword: true } });
      }
      case "/api/me": {
        const bearer = bearerOf(request);
        return json(200, bearer && this.tokens.has(bearer) ? { user: { email: "ada@example.org", quotaBytes: 1048576, hasPassword: true }, signIns: [] } : { user: null, signIns: [] });
      }
      case "/api/logout": {
        const bearer = bearerOf(request);
        if (bearer) this.tokens.delete(bearer);
        return json(200, { ok: true });
      }
      default:
        return json(404, { error: "There is nothing here." });
    }
  };
}

/** The shell's side, made up: the "browser" is a function that is given the address it was sent to, and answers as the person's browser would (or doesn't). */
function shell(
  server: StandInServer,
  browser: (url: URL, server: StandInServer) => Promise<SignInResult> | SignInResult | "never" = (url, made) => {
    // (the server made a code for the browser to carry back)
    made.codesLeft.add("code-1");
    return { code: "code-1", state: url.searchParams.get("state") ?? "" };
  },
) {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const opened: string[] = [];
  let stop: ((reason: Error) => void) | null = null;
  const settings = new Map<string, string>();
  const hooks: AccountHooks = {
    request: server.request,
    signIn: {
      begin: async () => {
        calls.push("begin");
        return { redirectUri: REDIRECT };
      },
      wait: (url) => {
        calls.push("wait");
        opened.push(url);
        const parsed = new URL(url);
        server.challenge = parsed.searchParams.get("code_challenge") ?? "";
        server.redirect = parsed.searchParams.get("redirect_uri") ?? "";
        const answer = browser(parsed, server);
        if (answer === "never") return new Promise<SignInResult>((_, reject) => (stop = reject));
        return Promise.resolve(answer);
      },
      cancel: () => {
        calls.push("cancel");
        stop?.(new Error("cancelled"));
      },
    },
    secrets: {
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => void secrets.set(name, value),
      remove: async (name) => void secrets.delete(name),
    },
  };
  const store = { get: (key: string) => settings.get(key) ?? null, set: (key: string, value: string) => void settings.set(key, value), remove: (key: string) => void settings.delete(key) };
  return { hooks, secrets, calls, opened, settings, store };
}

describe("the address of a server", () => {
  it("is its origin: https, or http to this computer's own address, with no name, folder or query", () => {
    for (const [typed, origin] of [
      ["https://notes.example.org", "https://notes.example.org"],
      ["  notes.example.org  ", "https://notes.example.org"],
      ["HTTPS://Notes.Example.org/", "https://notes.example.org"],
      ["https://notes.example.org:8443", "https://notes.example.org:8443"],
      ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
      ["http://localhost:3000/", "http://localhost:3000"],
      ["http://[::1]:8080", "http://[::1]:8080"],
    ] as const) {
      expect(parseServer(typed), typed).toEqual({ server: origin });
    }
    for (const typed of ["", "   ", "http://notes.example.org", "http://192.168.1.10:8080", "ftp://notes.example.org", "https://ada:secret@notes.example.org", "https://notes.example.org/zim", "https://notes.example.org/?x=1", "https://notes.example.org/#x", "javascript:alert(1)", "https://", "a b c"]) {
      expect(parseServer(typed), typed).toHaveProperty("problem");
    }
  });
});

describe("the secret that goes with a request", () => {
  it("is hashed as RFC 7636 says, and random each time", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(a);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("connecting an app to an account", () => {
  it("asks the shell for the browser with a request that has the challenge of a secret it keeps, trades the code for a token, and keeps the token in the shell's keychain only", async () => {
    const server = new StandInServer();
    const made = shell(server);
    const native = new NativeAccount(made.hooks, made.store);
    const shown: string[] = [];
    const account = await native.connect(`  ${SERVER}/ `, (url) => shown.push(url));
    expect(account.email).toBe("ada@example.org");
    // the browser was sent to the server's page for apps, with a return address, a hash of a secret, and a state
    const url = new URL(made.opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(`${SERVER}/`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ app: "authorize", redirect_uri: REDIRECT, code_challenge_method: "S256" });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(shown).toEqual([made.opened[0]]);
    // the first thing asked of the server was whether it is one, with no token; the secret itself went only in the trade
    expect(made.calls).toEqual(["begin", "wait"]);
    expect(server.log[0]!.url).toBe(`${SERVER}/api/providers`);
    expect(server.log[0]!.headers.authorization).toBeUndefined();
    const trade = server.log.find((r) => r.url.endsWith("/api/app/token"))!;
    expect(trade.method).toBe("POST");
    expect(trade.headers["x-requested-with"]).toBe("zim");
    expect(trade.headers.authorization).toBeUndefined();
    expect(made.opened.join(" ")).not.toContain(JSON.parse(trade.body!).code_verifier);
    // the token is in the keychain, and nowhere the page's own storage could show it
    const token = [...server.tokens][0]!;
    expect(made.secrets.get("account-token")).toBe(token);
    expect(JSON.stringify([...made.settings])).not.toContain(token);
    expect(made.settings.get(SERVER_SETTING)).toBe(SERVER);
    expect(native.server).toBe(SERVER);
    // what is asked of the server afterwards carries it, and goes to the server's address only
    expect((await native.client.me())?.email).toBe("ada@example.org");
    const me = server.log.at(-1)!;
    expect(me.url).toBe(`${SERVER}/api/me`);
    expect(me.headers.authorization).toBe(`Bearer ${token}`);
    expect(new Set(server.log.map((r) => new URL(r.url).origin))).toEqual(new Set([SERVER]));
  });

  it("refuses an answer that is not to its own request, or that says it failed, and shows nothing of what it said", async () => {
    for (const [answer, message] of [
      [{ code: "code-1", state: "somebody else's state" } as SignInResult, /not to this request/],
      [{ code: "code-1" } as SignInResult, /not to this request/],
      [{ error: "<b>access_denied</b>", state: "" } as SignInResult, /not to this request|did not work/],
    ] as const) {
      const server = new StandInServer();
      const made = shell(server, (url) => ({ ...answer, ...(answer.state === "" ? { state: url.searchParams.get("state") ?? "" } : {}) }));
      const native = new NativeAccount(made.hooks, made.store);
      const failure = await native.connect(SERVER).then(() => null, (error: Error) => error);
      expect(failure?.message, JSON.stringify(answer)).toMatch(message);
      expect(failure?.message).not.toContain("<b>");
      expect(server.log.some((r) => r.url.endsWith("/api/app/token")), "no trade").toBe(false);
      expect(made.secrets.size).toBe(0);
      expect(made.settings.size).toBe(0);
    }
    // (an answer that has a code and also says that it failed: the failure counts)
    const both = new StandInServer();
    const bothMade = shell(both, (url, made) => {
      made.codesLeft.add("code-1");
      return { code: "code-1", error: "access_denied", state: url.searchParams.get("state") ?? "" };
    });
    await expect(new NativeAccount(bothMade.hooks, bothMade.store).connect(SERVER)).rejects.toThrow(/did not work in the browser/);
    expect(bothMade.secrets.size).toBe(0);
    // (an answer with a right state and no code at all)
    const server = new StandInServer();
    const made = shell(server, (url) => ({ state: url.searchParams.get("state") ?? "" }));
    await expect(new NativeAccount(made.hooks, made.store).connect(SERVER)).rejects.toThrow(/did not work in the browser/);
    expect(made.secrets.size).toBe(0);
  });

  it("does not take a code for a request that is not its own, even from the right state", async () => {
    const server = new StandInServer();
    // (a code that the server did not make: the trade is refused, and nothing is kept)
    const made = shell(server, (url) => ({ code: "never-made", state: url.searchParams.get("state") ?? "" }));
    const native = new NativeAccount(made.hooks, made.store);
    const failure = await native.connect(SERVER).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("bad-grant");
    expect(made.secrets.size).toBe(0);
    expect(native.server).toBeNull();
  });

  it("stops waiting when it is cancelled, and says so by a cancel and not by a failure", async () => {
    const server = new StandInServer();
    const made = shell(server, () => "never");
    const native = new NativeAccount(made.hooks, made.store);
    const connecting = native.connect(SERVER);
    // (the wait has begun once the browser was sent for)
    for (let i = 0; i < 50 && !made.calls.includes("wait"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(made.calls).toEqual(["begin", "wait"]);
    native.cancel();
    await expect(connecting).rejects.toBeInstanceOf(SignInCancelled);
    expect(made.calls).toEqual(["begin", "wait", "cancel"]);
    expect(made.secrets.size).toBe(0);
    // and cancelling when nothing is being waited for does nothing
    native.cancel();
    expect(made.calls.filter((c) => c === "cancel")).toHaveLength(1);
  });

  it("does not open the browser for a person who cancelled while the server was still being asked", async () => {
    const server = new StandInServer();
    const made = shell(server);
    const slow = server.request;
    server.request = async (request) => {
      const answer = await slow(request);
      await new Promise((r) => setTimeout(r, 20));
      return answer;
    };
    const native = new NativeAccount({ ...made.hooks, request: server.request }, made.store);
    const connecting = native.connect(SERVER);
    native.cancel();
    await expect(connecting).rejects.toBeInstanceOf(SignInCancelled);
    expect(made.calls).not.toContain("begin");
    expect(made.opened).toEqual([]);
  });

  it("says why an address does not do, before the browser is opened for it", async () => {
    // not an account server
    let server = new StandInServer();
    server.providers = { status: 404, headers: { "content-type": "text/html" }, body: "<html>not found</html>" };
    let made = shell(server);
    await expect(new NativeAccount(made.hooks, made.store).connect(SERVER)).rejects.toThrow(/does not work as an account server/);
    expect(made.calls).toEqual([]);
    // an answer of the right kind that is not this server's
    server = new StandInServer();
    server.providers = json(200, { providers: [], email: false });
    made = shell(server);
    await expect(new NativeAccount(made.hooks, made.store).connect(SERVER)).rejects.toThrow(/does not work as an account server/);
    // the certificate is not trusted: the shell's words are the ones that are shown
    server = new StandInServer();
    server.down = new Error("the certificate is not one that this computer trusts");
    made = shell(server);
    await expect(new NativeAccount(made.hooks, made.store).connect(SERVER)).rejects.toThrow(/certificate is not one that this computer trusts/);
    expect(made.calls).toEqual([]);
    // an address that is not one
    await expect(new NativeAccount(made.hooks, made.store).connect("http://notes.example.org")).rejects.toThrow(/https/);
  });

  it("ends the token on the server when it can't be kept on this device, and keeps nothing", async () => {
    const server = new StandInServer();
    const made = shell(server);
    made.hooks.secrets.set = async () => {
      throw new Error("no keychain and no folder to write in");
    };
    const native = new NativeAccount(made.hooks, made.store);
    await expect(native.connect(SERVER)).rejects.toThrow(/can't keep what it needs.*no keychain/);
    expect(server.tokens.size, "the token that was made was ended").toBe(0);
    expect(made.settings.size).toBe(0);
    expect(native.server).toBeNull();
  });

  it("is signed out for good, here and on the server", async () => {
    const server = new StandInServer();
    const made = shell(server);
    const native = new NativeAccount(made.hooks, made.store);
    await native.connect(SERVER);
    expect(server.tokens.size).toBe(1);
    expect(await native.disconnect()).toBe(true);
    expect(server.tokens.size, "ended on the server").toBe(0);
    expect(made.secrets.size, "and forgotten here").toBe(0);
    expect(native.server).toBeNull();
    expect(await native.hasToken()).toBe(false);
    // a server that can't be told: this app is signed out all the same, and it says the server was not told
    await native.connect(SERVER);
    const down = made.hooks.request;
    made.hooks.request = async () => {
      throw new Error("no route to the server");
    };
    expect(await native.disconnect()).toBe(false);
    expect(made.secrets.size).toBe(0);
    expect(native.server).toBeNull();
    made.hooks.request = down;
  });

  it("asks the keychain again when it could not be read, instead of taking that for no token", async () => {
    const server = new StandInServer();
    const made = shell(server);
    const native = new NativeAccount(made.hooks, made.store);
    await native.connect(SERVER);
    const real = made.hooks.secrets.get;
    let locked = true;
    made.hooks.secrets.get = async (name) => {
      if (locked) throw new Error("the keychain is locked");
      return real(name);
    };
    // (a new run of the app: nothing is read yet)
    const again = new NativeAccount(made.hooks, made.store);
    expect(await again.hasToken(), "locked: no token that can be read").toBe(false);
    locked = false;
    expect(await again.hasToken(), "unlocked: the token is there").toBe(true);
    expect((await again.client.me())?.email).toBe("ada@example.org");
  });

  it("asks for nothing that is not an /api/ address of its own server", async () => {
    const server = new StandInServer();
    const made = shell(server);
    const native = new NativeAccount(made.hooks, made.store);
    await native.connect(SERVER);
    server.log.length = 0;
    const fetcher = (native as unknown as { fetcher(s: () => string | null, t: () => Promise<string | null>): (input: string, init?: RequestInit) => Promise<Response> }).fetcher(() => SERVER, async () => "t".repeat(43));
    for (const input of ["//evil.example/api/me", "https://evil.example/api/me", "/other", "/api", "/apix/me"]) {
      await expect(fetcher(input), input).rejects.toBeInstanceOf(TransportError);
    }
    expect(server.log).toEqual([]);
  });
});

/** Two fingerprints as a shell writes them (capitals, colons). */
const FP_A = Array.from({ length: 32 }, (_, i) => (i * 7 + 1).toString(16).padStart(2, "0").toUpperCase()).join(":");
const FP_B = Array.from({ length: 32 }, (_, i) => (i * 11 + 5).toString(16).padStart(2, "0").toUpperCase()).join(":");

/**
 * What a shell does about a certificate that the system does not know, as far as the page can tell (the real ones are tried against real TLS servers: the program's Rust tests, the device
 * test): a request to an origin is refused with `CERTIFICATE_UNTRUSTED` unless a certificate was trusted for it, and with `CERTIFICATE_CHANGED` if the one trusted is not what the server
 * shows; `inspect` says what the server shows; `pin` keeps it only if the server shows it now.
 */
function trusting(made: ReturnType<typeof shell>, shown: { fingerprint: string; knownToSystem?: boolean }) {
  const pins = new Map<string, string>();
  const calls: string[] = [];
  const through = made.hooks.request;
  made.hooks.request = async (request) => {
    const origin = new URL(request.url).origin;
    const pin = pins.get(origin);
    if (pin !== undefined && !sameFingerprint(pin, shown.fingerprint)) throw Object.assign(new Error("The server's certificate is not the one that you trusted for it."), { code: CERTIFICATE_CHANGED });
    if (pin === undefined && !shown.knownToSystem) throw Object.assign(new Error("The server's certificate is not one that this computer trusts (self-signed certificate)."), { code: CERTIFICATE_UNTRUSTED });
    return through(request);
  };
  made.hooks.trust = {
    inspect: async (origin) => {
      calls.push(`inspect ${origin}`);
      return { fingerprint: shown.fingerprint, names: ["notes.example.org"] } satisfies CertificateInfo;
    },
    pin: async (origin, fingerprint) => {
      calls.push(`pin ${origin} ${fingerprint}`);
      if (!sameFingerprint(fingerprint, shown.fingerprint)) throw new Error("The server shows another certificate now.");
      pins.set(origin, fingerprint);
    },
    pinned: async (origin) => pins.get(origin) ?? null,
    unpin: async (origin) => {
      calls.push(`unpin ${origin}`);
      pins.delete(origin);
    },
  };
  return { pins, calls };
}

describe("a server whose certificate the system does not know", () => {
  /** An app, a server that shows `FP_A`, and the questions that the person was put to (answered with `answers`, in order). */
  const setup = (answers: boolean[] = [true]) => {
    const server = new StandInServer();
    const made = shell(server);
    const trust = trusting(made, { fingerprint: FP_A });
    const native = new NativeAccount(made.hooks, made.store);
    const asked: CertificateQuestion[] = [];
    const ask = async (question: CertificateQuestion) => {
      asked.push(question);
      trust.calls.push("ask");
      return answers.shift() ?? false;
    };
    return { server, made, trust, native, asked, ask };
  };

  it("is put to the person with its fingerprint before anything else, and is trusted only if they say yes: then the browser is opened and the account is connected", async () => {
    const { server, made, trust, native, asked, ask } = setup();
    expect(native.canTrustCertificates).toBe(true);
    const account = await native.connect(SERVER, undefined, ask);
    expect(account.email).toBe("ada@example.org");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "new", previous: null, server: SERVER, info: { fingerprint: FP_A } });
    expect(asked[0]!.reason, "the shell's own words are shown").toMatch(/not one that this computer trusts/);
    // looked at first, put to the person, and only then trusted (for the server's address and for what was looked at); the browser comes after
    expect(trust.calls).toEqual([`inspect ${SERVER}`, "ask", `pin ${SERVER} ${FP_A}`]);
    expect(made.calls).toEqual(["begin", "wait"]);
    expect(trust.pins.get(SERVER)).toBe(FP_A);
    // what went to the server before the certificate was trusted went nowhere: the shell refused it, so the server saw the first request only once it was trusted
    expect(server.log.map((r) => new URL(r.url).pathname)).toEqual(["/api/providers", "/api/app/token"]);
    expect(server.log.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("is not trusted when the person says no: nothing is kept, the browser is not opened, and the refusal is not a failure to explain", async () => {
    const { server, made, trust, native, asked, ask } = setup([false]);
    const failure = await native.connect(SERVER, undefined, ask).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CertificateRefused);
    expect((failure as Error).message).toMatch(/did not trust that server's certificate, so nothing was connected/);
    expect(asked).toHaveLength(1);
    expect(trust.pins.size).toBe(0);
    expect(trust.calls).toEqual([`inspect ${SERVER}`, "ask"]);
    expect(made.calls).toEqual([]);
    expect(server.log).toEqual([]);
    expect(made.secrets.size).toBe(0);
    expect(made.settings.size).toBe(0);
  });

  it("is asked about again, with the one that was trusted, when the server shows another: a new one is trusted only if the person says yes, and an old one is kept if they say no", async () => {
    // yes: the new one replaces the old one
    let setting = setup([true]);
    setting.trust.pins.set(SERVER, FP_B);
    await setting.native.connect(SERVER, undefined, setting.ask);
    expect(setting.asked).toHaveLength(1);
    expect(setting.asked[0]).toMatchObject({ kind: "changed", previous: FP_B, info: { fingerprint: FP_A } });
    expect(setting.asked[0]!.reason).toMatch(/not the one that you trusted/);
    expect(setting.trust.pins.get(SERVER)).toBe(FP_A);
    // no: what was trusted stays, and nothing else happens
    setting = setup([false]);
    setting.trust.pins.set(SERVER, FP_B);
    await expect(setting.native.connect(SERVER, undefined, setting.ask)).rejects.toBeInstanceOf(CertificateRefused);
    expect(setting.trust.pins.get(SERVER), "the old one stays").toBe(FP_B);
    expect(setting.made.calls).toEqual([]);
  });

  it("asks nothing of a certificate that was trusted and is shown again, and nothing of one that the system knows", async () => {
    const trusted = setup();
    trusted.trust.pins.set(SERVER, FP_A.toLowerCase().replace(/:/g, " "));
    await trusted.native.connect(SERVER, undefined, trusted.ask);
    expect(trusted.asked, "the same fingerprint, written otherwise").toEqual([]);
    const server = new StandInServer();
    const made = shell(server);
    const known = trusting(made, { fingerprint: FP_A, knownToSystem: true });
    await new NativeAccount(made.hooks, made.store).connect(SERVER, undefined, async () => {
      throw new Error("asked");
    });
    expect(known.calls, "nothing was looked at, and nothing kept").toEqual([]);
  });

  it("is refused, with the shell's words, when the person can't be asked or the shell can't keep what they trust", async () => {
    // no way to ask: the server does not work, and nothing was looked at
    let setting = setup();
    await expect(setting.native.connect(SERVER)).rejects.toThrow(/does not work as an account server: The server's certificate is not one that this computer trusts/);
    expect(setting.trust.calls).toEqual([]);
    // a shell that can't keep what is trusted
    setting = setup();
    delete setting.made.hooks.trust;
    const without = new NativeAccount(setting.made.hooks, setting.made.store);
    expect(without.canTrustCertificates).toBe(false);
    await expect(without.connect(SERVER, undefined, setting.ask)).rejects.toThrow(/does not work as an account server: The server's certificate is not one that this computer trusts/);
    expect(setting.asked).toEqual([]);
    expect(await without.pinned(SERVER)).toBeNull();
  });

  it("says when the certificate could not be looked at, or could not be trusted, and does not go round again", async () => {
    let setting = setup();
    setting.made.hooks.trust!.inspect = async () => {
      throw new Error("The server did not answer.");
    };
    await expect(setting.native.connect(SERVER, undefined, setting.ask)).rejects.toThrow(/could not be looked at: The server did not answer/);
    expect(setting.asked).toEqual([]);
    // the shell looked again and the server showed another one: nothing is trusted
    setting = setup();
    let shown = FP_A;
    setting.made.hooks.trust!.inspect = async () => ({ fingerprint: shown });
    setting.made.hooks.trust!.pin = async () => {
      throw new Error("The server shows another certificate now.");
    };
    await expect(setting.native.connect(SERVER, undefined, async (question) => ((shown = FP_B), (void question, true)))).rejects.toThrow(/could not be trusted: The server shows another certificate now/);
    // a trust that does not take (the server is refused all the same): the person is asked once, not again and again
    setting = setup([true, true, true]);
    setting.made.hooks.trust!.pin = async () => undefined;
    await expect(setting.native.connect(SERVER, undefined, setting.ask)).rejects.toThrow(/does not work as an account server/);
    expect(setting.asked).toHaveLength(1);
  });

  it("is not asked about when the person cancels while the shell is looking, and the browser is not opened", async () => {
    const { made, native, trust } = setup();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const inspect = made.hooks.trust!.inspect;
    made.hooks.trust!.inspect = async (origin) => {
      await slow;
      return inspect(origin);
    };
    const asked: number[] = [];
    const connecting = native.connect(SERVER, undefined, async () => (asked.push(1), true));
    for (let i = 0; i < 50 && !trust.calls.length; i++) await new Promise((r) => setTimeout(r, 2));
    native.cancel();
    release();
    await expect(connecting).rejects.toBeInstanceOf(SignInCancelled);
    expect(asked).toEqual([]);
    // (the shell was told to stop; it was never sent for the browser)
    expect(made.calls).toEqual(["cancel"]);
    expect(made.opened).toEqual([]);
    expect(trust.pins.size).toBe(0);
  });

  it("is forgotten with the connection: signing out, and a connection to another server, drop what was trusted for the one that is left", async () => {
    const { made, trust, native, ask } = setup([true, true, true]);
    await native.connect(SERVER, undefined, ask);
    expect(trust.pins.get(SERVER)).toBe(FP_A);
    expect(await native.pinned()).toBe(FP_A);
    await native.disconnect();
    expect(trust.pins.size).toBe(0);
    expect(await native.pinned()).toBeNull();
    // connected to another server before: its trust goes when this server replaces it
    made.store.set(SERVER_SETTING, "https://old.example.org");
    trust.pins.set("https://old.example.org", FP_B);
    await new NativeAccount(made.hooks, made.store).connect(SERVER, undefined, ask);
    expect([...trust.pins.keys()]).toEqual([SERVER]);
    // and the token that goes with a lost connection keeps both the address and what was trusted: signing in again is one step
    const again = new NativeAccount(made.hooks, made.store);
    await again.forgetToken();
    expect(again.server).toBe(SERVER);
    expect(trust.pins.get(SERVER)).toBe(FP_A);
  });

  it("is told to what is asked of the server afterwards as a refusal about the certificate, not as a server that is down", async () => {
    const { made, trust, native, ask } = setup();
    await native.connect(SERVER, undefined, ask);
    expect((await native.client.me())?.email).toBe("ada@example.org");
    // the server shows another certificate: what was trusted is not it
    trust.pins.set(SERVER, FP_B);
    const changed = await native.client.me().then(() => null, (error: unknown) => error);
    expect(changed).toBeInstanceOf(ApiError);
    expect((changed as ApiError).code).toBe(CERTIFICATE_CHANGED);
    expect((changed as ApiError).message).toMatch(/not the one that you trusted/);
    // while a server that is down is still told as that
    made.hooks.request = async () => {
      throw new Error("The server did not answer.");
    };
    const down = await native.client.me().then(() => null, (error: unknown) => error);
    expect((down as ApiError).code).toBe("offline");
    // (a code that the page does not act on is not passed on)
    made.hooks.request = async () => {
      throw Object.assign(new Error("odd"), { code: "something-else" });
    };
    expect(((await native.client.me().then(() => null, (error: unknown) => error)) as ApiError).code).toBe("offline");
  });

  it("is told by what a shell rejects with: an error, an object with a message, or words", async () => {
    for (const failure of [Object.assign(new Error("words"), { code: CERTIFICATE_UNTRUSTED }), { message: "words", code: CERTIFICATE_UNTRUSTED }]) {
      const server = new StandInServer();
      const made = shell(server);
      made.store.set(SERVER_SETTING, SERVER);
      made.hooks.request = async () => {
        throw failure;
      };
      const error = await new NativeAccount(made.hooks, made.store).client.me().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(CERTIFICATE_UNTRUSTED);
      expect((error as ApiError).message).toBe("words");
    }
    const server = new StandInServer();
    const made = shell(server);
    made.store.set(SERVER_SETTING, SERVER);
    made.hooks.request = async () => {
      throw "just words" as unknown as Error;
    };
    const error = (await new NativeAccount(made.hooks, made.store).client.me().then(() => null, (e: unknown) => e)) as ApiError;
    expect([error.code, error.message]).toEqual(["offline", "just words"]);
  });

  it("compares fingerprints however they are written, and only whole ones", () => {
    expect(sameFingerprint(FP_A, FP_A.toLowerCase())).toBe(true);
    expect(sameFingerprint(FP_A, FP_A.replace(/:/g, " "))).toBe(true);
    expect(sameFingerprint(FP_A, FP_A.replace(/:/g, ""))).toBe(true);
    expect(sameFingerprint(FP_A, FP_B)).toBe(false);
    expect(sameFingerprint(FP_A.slice(0, -3), FP_A.slice(0, -3)), "a short one is no fingerprint, even if it is equal to itself").toBe(false);
    expect(sameFingerprint("", "")).toBe(false);
    // (what only differs in the last digit)
    expect(sameFingerprint(FP_A, `${FP_A.slice(0, -1)}${FP_A.endsWith("0") ? "1" : "0"}`)).toBe(false);
  });
});

describe("what the menu says of a certificate that the app was refused", () => {
  it("is said once, and leads to the certificate, until it is trusted; a server that is down says nothing of one", async () => {
    const server = new StandInServer();
    const made = shell(server);
    const trust = trusting(made, { fingerprint: FP_A });
    const native = new NativeAccount(made.hooks, made.store);
    const said: string[] = [];
    const accountUi = new NativeAccountUi((text) => said.push(text), () => {}, native);
    await native.connect(SERVER, undefined, async () => true);
    await accountUi.refresh();
    expect(accountUi.account?.email).toBe("ada@example.org");
    // (a new run: what the server shows is not what was trusted)
    trust.pins.set(SERVER, FP_B);
    const again = new NativeAccountUi((text) => said.push(text), () => {}, new NativeAccount(made.hooks, made.store));
    await again.refresh();
    expect(again.account, "no account is known while the certificate is refused").toBeNull();
    expect(again.menuLabel).toBe("The server's certificate…");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/not the one you trusted/);
    await again.refresh();
    expect(said, "said once").toHaveLength(1);
    // a server that is down is not a certificate
    made.hooks.request = async () => {
      throw new Error("The server did not answer.");
    };
    await again.refresh();
    expect(again.menuLabel).toBe("Connect to an account server…");
  });
});

describe("the address that the dialog starts with", () => {
  it("is the server that the app is connected to, else the one that the shell suggests if it is an address that can be used, else nothing", async () => {
    const server = new StandInServer();
    const made = shell(server);
    expect(new NativeAccount(made.hooks, made.store).suggested).toBe("");
    for (const bad of [null, undefined, "", "http://notes.example.org", "https://ada:secret@notes.example.org", "not an address"]) {
      expect(new NativeAccount({ ...made.hooks, defaultServer: bad }, made.store).suggested, String(bad)).toBe("");
    }
    const suggesting = { ...made.hooks, defaultServer: "  Notes.Example.org " };
    expect(new NativeAccount(suggesting, made.store).suggested).toBe("https://notes.example.org");
    // (connected: the server it is connected to wins over what the shell suggests)
    const native = new NativeAccount({ ...suggesting, defaultServer: "https://another.example.org" }, made.store);
    await native.connect(SERVER);
    expect(native.suggested).toBe(SERVER);
    await native.disconnect();
    expect(native.suggested).toBe("https://another.example.org");
  });
});

describe("what an app that is connected knows of the account", () => {
  const ui = async () => {
    const server = new StandInServer();
    const made = shell(server);
    const native = new NativeAccount(made.hooks, made.store);
    const said: string[] = [];
    const accountUi = new NativeAccountUi((text) => said.push(text), () => {}, native);
    return { server, made, native, said, accountUi };
  };

  it("always has something to say in the menu, and says who it is connected as", async () => {
    const { native, accountUi } = await ui();
    expect(accountUi.available).toBe(true);
    expect(accountUi.menuLabel).toBe("Connect to an account server…");
    expect(accountUi.inBrowser).toBe(false);
    await native.connect(SERVER);
    await accountUi.refresh();
    expect(accountUi.account?.email).toBe("ada@example.org");
    expect(accountUi.menuLabel).toBe("Account (ada@example.org)…");
  });

  it("is signed out, and says so, when the server no longer knows its token, and is not when the server can't be reached", async () => {
    const { server, made, native, said, accountUi } = await ui();
    await native.connect(SERVER);
    await accountUi.refresh();
    expect(accountUi.account).not.toBeNull();
    // the server can't be reached: nothing changes
    const up = made.hooks.request;
    made.hooks.request = async () => {
      throw new Error("offline");
    };
    await accountUi.refresh();
    expect(accountUi.account?.email, "what was known stays").toBe("ada@example.org");
    expect(said).toEqual([]);
    made.hooks.request = up;
    // the server ended the token (from the account's list, or a new password)
    server.tokens.clear();
    let changed = 0;
    accountUi.onChange = () => changed++;
    await accountUi.refresh();
    expect(accountUi.account).toBeNull();
    expect(said.join(" ")).toMatch(/signed this app out/);
    expect(made.secrets.size, "the token that is no good is forgotten").toBe(0);
    expect(native.server, "the address is kept: one step to connect again").toBe(SERVER);
    await new Promise((r) => setTimeout(r, 5));
    expect(changed).toBe(1);
    // and with nothing connected there is nothing to ask
    server.log.length = 0;
    await accountUi.refresh();
    expect(server.log).toEqual([]);
  });

  it("reads the account at the start only if it was connected", async () => {
    const { server, made, native, accountUi } = await ui();
    await accountUi.start();
    expect(server.log).toEqual([]);
    await native.connect(SERVER);
    // (a new run of the app: the address and the token are what is left)
    const again = new NativeAccountUi(() => {}, () => {}, new NativeAccount(made.hooks, made.store));
    server.log.length = 0;
    await again.start();
    expect(again.account?.email).toBe("ada@example.org");
    expect(server.log.map((r) => new URL(r.url).pathname)).toEqual(["/api/me"]);
  });
});

describe("a request that an app makes to the page it sends the person to", () => {
  const challenge = "A".repeat(43);
  const state = "s".repeat(22);
  const good = () => new URLSearchParams({ app: "authorize", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state });

  it("is read from the address, and only if it is one that can be answered", () => {
    expect(parseAppRequest(good())).toEqual({ redirectUri: REDIRECT, challenge, state });
    const android = good();
    android.set("redirect_uri", "org.zimnotebook.app:/callback");
    expect(parseAppRequest(android)?.redirectUri).toBe("org.zimnotebook.app:/callback");
    const iphone = good();
    iphone.set("redirect_uri", "org.zimnotebook.app.ios:/callback");
    expect(parseAppRequest(iphone)?.redirectUri).toBe("org.zimnotebook.app.ios:/callback");
    for (const [name, value] of [
      ["app", "other"],
      ["redirect_uri", "https://evil.example/callback"],
      ["redirect_uri", "http://127.0.0.1:80/callback"],
      ["redirect_uri", `${REDIRECT}?x=1`],
      ["redirect_uri", "org.zimnotebook.app.ios:/callback?x=1"],
      ["redirect_uri", "org.zimnotebook.app.ios://callback"],
      ["redirect_uri", "org.zimnotebook.app.ios:/other"],
      ["redirect_uri", "org.zimnotebook.app.android:/callback"],
      ["redirect_uri", ""],
      ["code_challenge", "short"],
      ["code_challenge", `${"A".repeat(42)}+`],
      ["code_challenge_method", "plain"],
      ["state", "short"],
      ["state", `${"s".repeat(20)}&x`],
    ] as const) {
      const params = good();
      params.set(name, value);
      expect(parseAppRequest(params), `${name}=${value}`).toBeNull();
    }
    for (const name of APP_PARAMS.filter((n) => n !== "app")) {
      const params = good();
      params.delete(name);
      expect(parseAppRequest(params), `without ${name}`).toBeNull();
    }
    expect(appKind(REDIRECT)).toBe("desktop");
    expect(appKind("org.zimnotebook.app:/callback")).toBe("android");
    expect(appKind("org.zimnotebook.app.ios:/callback")).toBe("ios");
    expect(appKind("http://localhost:49152/callback")).toBeNull();
  });

  it("is kept for the few minutes that signing in with a service takes, once, and not longer", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) } as unknown as Storage;
    const request = parseAppRequest(good())!;
    keepAppRequest(request, storage, 1_000_000);
    expect(takeAppRequest(storage, 1_000_000 + 9 * 60_000)).toEqual(request);
    expect(takeAppRequest(storage, 1_000_000 + 9 * 60_000), "taken once").toBeNull();
    keepAppRequest(request, storage, 1_000_000);
    expect(takeAppRequest(storage, 1_000_000 + 11 * 60_000), "too late").toBeNull();
    expect(memory.size, "and gone").toBe(0);
    keepAppRequest(request, storage, 1_000_000);
    expect(takeAppRequest(storage, 999_000), "from the future").toBeNull();
    // what was put there by anything else is not trusted: it is read as a request again
    memory.set("zim:app-request", JSON.stringify({ at: 1_000_000, request: { redirectUri: "https://evil.example/", challenge, state } }));
    expect(takeAppRequest(storage, 1_000_001)).toBeNull();
    memory.set("zim:app-request", "not json");
    expect(takeAppRequest(storage, 1_000_001)).toBeNull();
    // a tab that keeps nothing
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => keepAppRequest(request, broken)).not.toThrow();
    expect(takeAppRequest(broken)).toBeNull();
    expect(takeAppRequest(null)).toBeNull();
  });
});
