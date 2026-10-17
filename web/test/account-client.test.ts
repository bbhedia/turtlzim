import { describe, expect, it } from "vitest";
import { AccountClient, ApiError, SIGN_IN_PROBLEMS } from "../src/account/client";
import type { Fetcher } from "../src/account/client";

const json = (status: number, body: unknown, type = "application/json") => new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

function client(answer: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ path: string; init?: RequestInit }> = [];
  const doFetch: Fetcher = async (path, init) => {
    seen.push({ path, init });
    return answer(path, init);
  };
  return { api: new AccountClient(doFetch), seen };
}

describe("the account client", () => {
  it("says there is no account server when /api/providers is not one (a static host answers HTML or 404)", async () => {
    expect(await client(() => new Response("<html></html>", { headers: { "content-type": "text/html" } })).api.offer()).toBeNull();
    expect(await client(() => json(404, { error: "no" })).api.offer()).toBeNull();
    expect(await client(() => { throw new TypeError("offline"); }).api.offer()).toBeNull();
  });

  it("lists the services that are set up, and only known ones", async () => {
    const { api } = client(() => json(200, { email: true, providers: ["github", "myspace", "google"] }));
    expect(await api.offer()).toEqual({ providers: ["github", "google"] });
  });

  it("sends changes as JSON with the header that marks the page's own request, and reads with a plain GET", async () => {
    const { api, seen } = client(() => json(200, { ok: true }));
    await api.register("a@b.org", "secret secret");
    const post = seen[0]!;
    expect(post.path).toBe("/api/register");
    expect(post.init?.method).toBe("POST");
    expect(post.init?.credentials).toBe("same-origin");
    expect(post.init?.headers).toEqual({ "content-type": "application/json", "x-requested-with": "zim" });
    expect(JSON.parse(String(post.init?.body))).toEqual({ email: "a@b.org", password: "secret secret" });
    await client(() => json(200, { user: null, signIns: [] })).api.me();
    const { api: reader, seen: reads } = client(() => json(200, { user: null, signIns: [] }));
    await reader.me();
    expect(reads[0]!.init?.method).toBe("GET");
    expect(reads[0]!.init?.body).toBeUndefined();
  });

  it("reads the account's key for sealed copies, and keeps one with the key it replaces: a refusal carries the key that is there", async () => {
    const { api, seen } = client((_path, init) => (init?.method === "PUT" ? json(409, { error: "Not the key that was seen.", code: "conflict", wrapped: "QUJD", check: "ab", updatedAt: 5 }) : json(200, { wrapped: "QUJD", check: "ab", updatedAt: 5 })));
    expect(await api.getKeychain()).toEqual({ wrapped: "QUJD", check: "ab", updatedAt: 5 });
    expect(seen[0]!.path).toBe("/api/sync/keychain");
    expect(seen[0]!.init?.method).toBe("GET");
    const error = await api.putKeychain({ wrapped: "x", check: "c", expect: "none" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).data).toMatchObject({ wrapped: "QUJD", check: "ab" });
    const put = seen[1]!;
    expect(put.path).toBe("/api/sync/keychain");
    expect(put.init?.method).toBe("PUT");
    expect(put.init?.headers).toEqual({ "content-type": "application/json", "x-requested-with": "zim" });
    expect(JSON.parse(String(put.init?.body))).toEqual({ wrapped: "x", check: "c", expect: "none" });
  });

  it("asks to start the sealed copies over by naming the key it saw, and is told which key is there when it was another", async () => {
    const sum = "ab".repeat(32);
    const { api, seen } = client((_path, init) => (JSON.parse(String(init?.body)).expect === sum ? json(200, { ok: true, removed: 2 }) : json(409, { error: "Not the key that was seen.", code: "conflict", wrapped: "QUJD", check: "ab" })));
    expect(await api.resetKeychain(sum)).toEqual({ ok: true, removed: 2 });
    expect(seen[0]!.path).toBe("/api/sync/keychain/reset");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(seen[0]!.init?.headers).toEqual({ "content-type": "application/json", "x-requested-with": "zim" });
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ expect: sum });
    const error = await api.resetKeychain("cd".repeat(32)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).data).toMatchObject({ wrapped: "QUJD", check: "ab" });
  });

  it("knows who is signed in, and that nobody is", async () => {
    expect(await client(() => json(200, { user: null, signIns: [] })).api.me()).toBeNull();
    const me = await client(() => json(200, { user: { email: "a@b.org", quotaBytes: 1048576, hasPassword: false }, signIns: ["github", 5] })).api.me();
    expect(me).toEqual({ email: "a@b.org", quotaBytes: 1048576, hasPassword: false, signIns: ["github"] });
  });

  it("turns a refusal into an error with the server's words, its code and the wait", async () => {
    const { api } = client(() => json(429, { error: "Slow down.", code: "limited", retryAfter: 90 }));
    const error = await api.login("a@b.org", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Slow down.", status: 429, code: "limited", retryAfter: 90 });
  });

  it("does not take an answer that is not JSON for a success, and reports a server that can't be reached", async () => {
    await expect(client(() => new Response("hello", { status: 200 })).api.login("a", "b")).rejects.toMatchObject({ status: 200 });
    await expect(client(() => { throw new TypeError("x"); }).api.login("a", "b")).rejects.toMatchObject({ code: "offline" });
    await expect(client(() => json(500, "x")).api.login("a", "b")).rejects.toMatchObject({ message: "The server answered something unexpected." });
  });

  it("has a fixed message for every way a sign-in service's return can fail, and none that carries address text", () => {
    for (const code of ["no-provider", "expired", "cancelled", "failed", "unverified-email"]) expect(SIGN_IN_PROBLEMS[code]).toMatch(/\w/);
    expect(SIGN_IN_PROBLEMS["<b>"]).toBeUndefined();
  });
});
