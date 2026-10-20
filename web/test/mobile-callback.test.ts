// The browser's return to the Android app (mobile/shell/callback.ts) and the places that have to agree about the address it comes back to: the server's list of return addresses,
// the page that asks whether to allow the app, the app's manifest (the intent filter that Android hands the address by) and its id.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { answerOf, REDIRECT_URI } from "../../mobile/shell/callback";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const state = "s".repeat(22);

describe("the browser's return to the Android app", () => {
  it("is the app's own address with the state that this sign-in gave", () => {
    expect(answerOf(`${REDIRECT_URI}?code=C0DE&state=${state}`, state)).toEqual({ code: "C0DE", state });
    expect(answerOf(`${REDIRECT_URI}?error=access_denied&state=${state}`, state)).toEqual({ error: "access_denied", state });
    expect(answerOf(`${REDIRECT_URI}?code=a%2Bb%3D&state=${state}`, state)?.code).toBe("a+b=");
  });

  it("is not taken from any other address, from another state or none, or when no sign-in is waiting (any app on the phone can send this app an address like it)", () => {
    for (const [what, address, waiting] of [
      ["another state", `${REDIRECT_URI}?code=C0DE&state=somebody-elses-state`, state],
      ["no state", `${REDIRECT_URI}?code=C0DE`, state],
      ["an empty state", `${REDIRECT_URI}?code=C0DE&state=`, state],
      ["nothing waited for", `${REDIRECT_URI}?code=C0DE&state=${state}`, null],
      ["nothing waited for, and no state in the address either", `${REDIRECT_URI}?code=C0DE`, null],
      ["another path", `org.zimnotebook.app:/other?code=C0DE&state=${state}`, state],
      ["a host, not a path", `org.zimnotebook.app://callback?code=C0DE&state=${state}`, state],
      ["another scheme", `org.zimnotebook.other:/callback?code=C0DE&state=${state}`, state],
      ["the web", `https://evil.example/callback?code=C0DE&state=${state}`, state],
      ["not an address", "not an address", state],
      ["nothing", "", state],
    ] as const) {
      expect(answerOf(address, waiting), what).toBeNull();
    }
  });

  it("is the address that the server, the page and the manifest all know the app by", () => {
    expect(REDIRECT_URI).toBe("org.zimnotebook.app:/callback");
    expect(read("../../server/src/apps.mjs")).toContain(`export const ANDROID_REDIRECT = "${REDIRECT_URI}";`);
    expect(read("../src/account/app-request.ts")).toContain(`redirectUri === "${REDIRECT_URI}"`);
    const manifest = read("../../mobile/android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain(`<data android:scheme="${REDIRECT_URI.split(":")[0]}" />`);
    expect(manifest).toContain("android.intent.category.BROWSABLE");
    // (the scheme is the reverse of the app's id, which is what RFC 8252 asks of an address of this kind)
    expect(JSON.parse(read("../../mobile/capacitor.config.json")).appId).toBe(REDIRECT_URI.split(":")[0]);
  });
});
