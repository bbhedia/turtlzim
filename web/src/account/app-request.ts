// What an app asks of the browser it sends the person to, to be allowed to use their account (`native.ts` is the app's side, `server/src/apps.mjs` the server's): a return address that
// only that app receives, the hash of a secret that only it knows (PKCE), and a state it will check when the browser comes back. The page checks what it can (the server is the one that
// decides what is allowed) and keeps the request for a few minutes in the tab's own storage, because signing in with Google or GitHub leaves the page and comes back to it.

export interface AppRequest {
  redirectUri: string;
  challenge: string;
  state: string;
}

const STASH = "zim:app-request";
/** How long a request that was left (the person went away in the middle of signing in) is still the one to go on with. */
const KEEP_MS = 10 * 60 * 1000;

/** What kind of app a return address is the address of, to say so on the page (the server decides what is allowed): a program on a computer, an Android app, an iPhone app, or nothing it knows. */
export function appKind(redirectUri: string): "desktop" | "android" | "ios" | null {
  if (/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}\/callback$/.test(redirectUri)) return "desktop";
  if (redirectUri === "org.zimnotebook.app:/callback") return "android";
  return redirectUri === "org.zimnotebook.app.ios:/callback" ? "ios" : null;
}

export const APP_PARAMS = ["app", "redirect_uri", "code_challenge", "code_challenge_method", "state"];

/** The request that an address carries (`?app=authorize&…`), or null if it does not carry one that can be answered. */
export function parseAppRequest(params: URLSearchParams): AppRequest | null {
  if (params.get("app") !== "authorize" || params.get("code_challenge_method") !== "S256") return null;
  const redirectUri = params.get("redirect_uri") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  if (!appKind(redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  return { redirectUri, challenge, state };
}

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function keepAppRequest(request: AppRequest, storage: Storage | null = tabStorage(), now = Date.now()): void {
  try {
    storage?.setItem(STASH, JSON.stringify({ request, at: now }));
  } catch {
    // a browser that keeps nothing for the tab still answers a request that does not leave the page
  }
}

/** The request that was kept, if it is still recent (and it is no longer kept). */
export function takeAppRequest(storage: Storage | null = tabStorage(), now = Date.now()): AppRequest | null {
  let text: string | null = null;
  try {
    text = storage?.getItem(STASH) ?? null;
  } catch {
    return null;
  }
  dropAppRequest(storage);
  if (!text) return null;
  try {
    const kept = JSON.parse(text) as { request?: Partial<AppRequest>; at?: unknown };
    const r = kept.request;
    if (typeof kept.at !== "number" || now - kept.at > KEEP_MS || now < kept.at) return null;
    if (!r || typeof r.redirectUri !== "string" || typeof r.challenge !== "string" || typeof r.state !== "string") return null;
    const params = new URLSearchParams({ app: "authorize", redirect_uri: r.redirectUri, code_challenge: r.challenge, code_challenge_method: "S256", state: r.state });
    return parseAppRequest(params);
  } catch {
    return null;
  }
}

export function dropAppRequest(storage: Storage | null = tabStorage()): void {
  try {
    storage?.removeItem(STASH);
  } catch {
    // see above
  }
}
