import "./style.css";
import { App } from "./app/app";
import type { ZimEditor } from "./editor";
import { SAMPLE } from "./sample";
import { initZim } from "./zim";

declare global {
  interface Window {
    /** Set by a test (before the page's own scripts run) to be given `__zim`; a page nobody has set it on offers no handle on the app. */
    __ZIM_TEST__?: boolean;
    /** Test hook: the app, its editor, and the text the editor-only tests start from. */
    __zim?: { app: App; editor: ZimEditor; editorSample: string };
  }
}

async function main(): Promise<void> {
  const root = document.getElementById("app") as HTMLElement;
  await initZim();
  const app = await App.start(root);
  // (a handle on the app is a handle on whatever it has open, an unlocked encrypted notebook too: only a test asks for one)
  if (window.__ZIM_TEST__ === true) window.__zim = { app, editor: app.editor, editorSample: SAMPLE };
}

main().catch((error: unknown) => {
  const root = document.getElementById("app");
  if (root) root.textContent = `The notebook could not start: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
