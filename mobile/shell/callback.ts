// What the person's browser comes back to the app with (the answer to a sign-in, `web/src/account/native.ts`): the address `org.zimnotebook.app:/callback?code=…&state=…` that Android hands to the
// app. Kept apart from the shell's script so that the page's own tests can try it (web/test/mobile-callback.test.ts) without Capacitor.
import type { SignInResult } from "../../web/src/app/shell";

/** Where the browser is sent back to: the reverse of the app's id, which is what RFC 8252 asks of an address of this kind (and what the manifest's intent filter takes). */
export const REDIRECT_URI = "org.zimnotebook.app:/callback";

/**
 * What the browser came back with, if the address is the answer to the sign-in that is being waited for, else null. Any app on the phone can send this one an address like it, so only the
 * state that this sign-in gave tells: an address with another state (or none, or while nothing is waited for) is not taken.
 */
export function answerOf(address: string, state: string | null): SignInResult | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "org.zimnotebook.app:" || url.pathname !== "/callback" || state === null || url.searchParams.get("state") !== state) return null;
  return { code: url.searchParams.get("code") ?? undefined, state, error: url.searchParams.get("error") ?? undefined };
}
