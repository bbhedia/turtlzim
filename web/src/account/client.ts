// The account server, as the page sees it: JSON under `/api/` on the address the app came from (the page's content policy lets it ask nowhere else).
// Where there is no such server (a static host, a native shell, a test) `available()` says so and the app shows nothing about accounts.
// Notes never go through here: an account only exists, so far, and notebooks stay on the device.

export interface Account {
  email: string;
  quotaBytes: number;
  hasPassword: boolean;
  /** The services (`google`, `github`) this account can sign in with. */
  signIns: string[];
}

export interface Offer {
  providers: string[];
}

/** What a failed request says: the server's message (written for a person) and its code, for what the page does differently. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: number,
    /** The rest of what the server said (a conflict says which revision the server has). */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The messages for what the sign-in services' return trip can go wrong with: fixed text, never anything taken from the address. */
export const SIGN_IN_PROBLEMS: Record<string, string> = {
  "no-provider": "That way of signing in is not set up on this server.",
  expired: "The sign-in took too long or was already used. Try again.",
  cancelled: "The sign-in was cancelled.",
  failed: "The sign-in did not work. Try again.",
  "unverified-email": "That service did not confirm an e-mail address for you, so an account can't be made from it. Confirm one there, or sign up with your e-mail address.",
};

/** A notebook the server keeps. */
export interface RemoteNotebook {
  id: string;
  title: string;
  revision: number;
  updatedAt: number;
  bytes?: number;
}

/** A kind of service that can be connected: whether it is allowed through its own window (OAuth), and whether this server has what it needs to offer that. */
export interface ServiceKind {
  kind: string;
  label: string;
  oauth?: boolean;
  available?: boolean;
}

/** The messages for what the return from a service's window can go wrong with: fixed text, never anything taken from the address. */
export const CONNECT_PROBLEMS: Record<string, string> = {
  expired: "The connection took too long, or was not begun in this browser. Try again.",
  cancelled: "The service was not allowed access, so nothing was connected.",
  failed: "The connection did not work. Try again in a moment.",
  "no-refresh": "The service did not give a lasting access. Remove this app's access in the service's own settings, then connect again.",
  "no-provider": "That service is not set up on this server.",
  "signed-out": "You were signed out. Sign in, then connect the service again.",
  "too-many": "Too many services are connected already. Disconnect one first.",
  "bad-kind": "That kind of service can't be connected that way.",
};

/** A service that the person connected (never its settings: the server keeps those). */
export interface Connection {
  id: number;
  kind: string;
  label: string;
  service: string;
}

/** A file as it travels: its path in the notebook and its bytes in base64. */
export interface WireFile {
  path: string;
  base64: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class AccountClient {
  constructor(private readonly doFetch: Fetcher = (input, init) => fetch(input, init)) {}

  private async call<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    let response: Response;
    try {
      response = await this.doFetch(path, { method, credentials: "same-origin", cache: "no-store", headers: method === "GET" ? undefined : { "content-type": "application/json", "x-requested-with": "zim" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    } catch {
      throw new ApiError("The server can't be reached.", 0, "offline");
    }
    const type = response.headers.get("content-type") ?? "";
    const data = type.includes("json") ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
    if (!response.ok) {
      const retry = typeof data?.retryAfter === "number" ? data.retryAfter : undefined;
      throw new ApiError(typeof data?.error === "string" ? data.error : "The server answered something unexpected.", response.status, typeof data?.code === "string" ? data.code : undefined, retry, data ?? {});
    }
    if (data === null) throw new ApiError("The server answered something unexpected.", response.status);
    return data as T;
  }

  /** What this server offers, or null if there is no account server here. */
  async offer(): Promise<Offer | null> {
    try {
      const data = await this.call<{ providers?: unknown; email?: unknown }>("/api/providers");
      if (data.email !== true || !Array.isArray(data.providers)) return null;
      return { providers: data.providers.filter((p): p is string => p === "google" || p === "github") };
    } catch {
      return null;
    }
  }

  /** Who is signed in, or null. */
  async me(): Promise<Account | null> {
    const data = await this.call<{ user?: unknown }>("/api/me");
    return data.user === null ? null : toAccount(data);
  }

  register(email: string, password: string): Promise<unknown> {
    return this.call("/api/register", { email, password });
  }
  resend(email: string): Promise<unknown> {
    return this.call("/api/resend", { email });
  }
  async verify(email: string, code: string): Promise<Account> {
    return toAccount(await this.call("/api/verify", { email, code }));
  }
  async login(email: string, password: string): Promise<Account> {
    return toAccount(await this.call("/api/login", { email, password }));
  }
  logout(): Promise<unknown> {
    return this.call("/api/logout", {});
  }
  forgot(email: string): Promise<unknown> {
    return this.call("/api/password/forgot", { email });
  }
  reset(email: string, code: string, password: string): Promise<unknown> {
    return this.call("/api/password/reset", { email, code, password });
  }
  deleteAccount(password: string): Promise<unknown> {
    return this.call("/api/account/delete", { password });
  }
  listNotebooks(): Promise<{ notebooks: RemoteNotebook[]; usedBytes: number; quotaBytes: number }> {
    return this.call("/api/sync/notebooks");
  }
  getNotebook(id: string): Promise<RemoteNotebook & { files: WireFile[] }> {
    return this.call(`/api/sync/notebooks/${encodeURIComponent(id)}`);
  }
  getManifest(id: string): Promise<{ id: string; title: string; revision: number; files: Array<{ path: string; size: number; mark: string }> }> {
    return this.call(`/api/sync/notebooks/${encodeURIComponent(id)}/manifest`);
  }
  readNotebookFiles(id: string, paths: string[]): Promise<{ title: string; revision: number; files: WireFile[] }> {
    return this.call(`/api/sync/notebooks/${encodeURIComponent(id)}/read`, { paths });
  }
  patchNotebook(id: string, body: { title: string; baseRevision: number; put: WireFile[]; remove: string[] }): Promise<{ revision: number; usedBytes: number }> {
    return this.call(`/api/sync/notebooks/${encodeURIComponent(id)}`, body, "PATCH");
  }
  putNotebook(id: string, body: { title: string; baseRevision: number; files: WireFile[] }): Promise<{ revision: number; usedBytes: number }> {
    return this.call(`/api/sync/notebooks/${encodeURIComponent(id)}`, body, "PUT");
  }
  deleteNotebook(id: string): Promise<unknown> {
    return this.call(`/api/sync/notebooks/${encodeURIComponent(id)}`, {}, "DELETE");
  }
  listConnectors(): Promise<{ connectors: Connection[]; services: ServiceKind[] }> {
    return this.call("/api/connectors");
  }
  addConnector(kind: string, label: string, settings: Record<string, string>): Promise<Connection> {
    return this.call("/api/connectors", { kind, label, settings });
  }
  deleteConnector(id: number): Promise<unknown> {
    return this.call(`/api/connectors/${id}`, {}, "DELETE");
  }
  connectorFolders(id: number): Promise<{ folders: string[] }> {
    return this.call(`/api/connectors/${id}/folders`, {});
  }
  connectorList(id: number, dir: string): Promise<{ version: string; files: Array<{ path: string; size: number; mark: string }> }> {
    return this.call(`/api/connectors/${id}/list`, { dir });
  }
  connectorRead(id: number, dir: string, paths?: string[]): Promise<{ version: string; files: WireFile[] }> {
    return this.call(`/api/connectors/${id}/read`, paths ? { dir, paths } : { dir });
  }
  connectorWrite(id: number, dir: string, body: { baseVersion: string; put: WireFile[]; remove: string[] }): Promise<{ version: string }> {
    return this.call(`/api/connectors/${id}/write`, { dir, ...body });
  }
  /** The account's key for sealed copies, wrapped by a passphrase that the server does not have (null if there is none yet). */
  getKeychain(): Promise<{ wrapped: string | null; check?: string; updatedAt?: number }> {
    return this.call("/api/sync/keychain");
  }
  /** Keep the wrapped key: as the first (`expect: "none"`), or in place of the one whose SHA-256 is `expect`. A 409 says (in its data) which key is there. */
  putKeychain(body: { wrapped: string; check: string; expect: string }): Promise<{ ok: boolean }> {
    return this.call("/api/sync/keychain", body, "PUT");
  }
  /** Everything the server keeps about the person, as the text of a JSON file. */
  async exportData(): Promise<string> {
    return JSON.stringify(await this.call("/api/account/export"), null, 2);
  }
}

function toAccount(data: unknown): Account {
  const d = data as { user?: { email?: unknown; quotaBytes?: unknown; hasPassword?: unknown }; signIns?: unknown } | null;
  if (!d?.user || typeof d.user.email !== "string") throw new ApiError("The server answered something unexpected.", 200);
  return { email: d.user.email, quotaBytes: Number(d.user.quotaBytes) || 0, hasPassword: d.user.hasPassword === true, signIns: Array.isArray(d.signIns) ? d.signIns.filter((s): s is string => typeof s === "string") : [] };
}
