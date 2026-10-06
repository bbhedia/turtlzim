import "./style.css";
import { App } from "./app/app";
import type { ZimEditor } from "./editor";
import { SAMPLE } from "./sample";
import { initZim } from "./zim";

declare global {
  interface Window {
    /** Test hook: the app, its editor, and the text the editor-only tests start from. */
    __zim?: { app: App; editor: ZimEditor; editorSample: string };
  }
}

async function main(): Promise<void> {
  const root = document.getElementById("app") as HTMLElement;
  await initZim();
  const app = await App.start(root);
  window.__zim = { app, editor: app.editor, editorSample: SAMPLE };
}

main().catch((error: unknown) => {
  const root = document.getElementById("app");
  if (root) root.textContent = `The notebook could not start: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
