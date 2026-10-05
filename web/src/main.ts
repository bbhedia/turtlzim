import "./style.css";
import { createZimEditor } from "./editor";
import type { ZimEditor } from "./editor";
import { SAMPLE } from "./sample";
import { decodePage, encodePage, initZim } from "./zim";
import type { LineEnding } from "./zim";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

declare global {
  interface Window {
    /** Test hook: the demo's editor, once it is ready. */
    __zim?: { editor: ZimEditor };
  }
}

async function main(): Promise<void> {
  await initZim();
  const status = $("status");
  let fileName = "page.txt";
  // What the file was besides its text (a byte-order mark, CRLF line endings): the editor works on
  // clean text, and saving puts these back so the file is written exactly as it was read.
  let bom = false;
  let lineEnding: LineEnding = "lf";
  let dirty = false;
  const show = (message: string): void => {
    status.textContent = message;
  };

  const editor = createZimEditor($("editor"), SAMPLE, {
    onChange: () => {
      dirty = true;
      show(`${editor.view.state.doc.length} characters, edited`);
    },
    onNavigate: (link) => show(`Would follow a ${link.kind} link to ${link.target}`),
  });
  window.__zim = { editor };
  show("Ready. Edit the sample page, or open one of your own.");

  const load = (text: string, name: string, file: { bom: boolean; lineEnding: LineEnding }): void => {
    editor.setText(text);
    fileName = name;
    ({ bom, lineEnding } = file);
    dirty = false;
    const notes = [bom ? "byte-order mark" : "", lineEnding === "lf" ? "" : `${lineEnding.toUpperCase()} line endings`];
    show(`Opened ${name}: ${text.length} characters${notes.some(Boolean) ? ` (${notes.filter(Boolean).join(", ")}, kept on save)` : ""}`);
  };

  $<HTMLInputElement>("open").addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const page = decodePage(new Uint8Array(await file.arrayBuffer()));
      load(page.text, file.name, page);
    } catch {
      show(`${file.name} is not valid UTF-8, so it was not opened (Zim pages are always UTF-8).`);
    }
  });

  $("save").addEventListener("click", () => {
    const bytes = encodePage({ text: editor.getText(), bom, lineEnding });
    const blob = new Blob([bytes as BlobPart], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);
    dirty = false;
    show(`Saved a copy as ${fileName}`);
  });

  $<HTMLInputElement>("markup").addEventListener("change", (event) => {
    editor.setShowMarkup((event.target as HTMLInputElement).checked);
  });

  $("sample").addEventListener("click", () => load(SAMPLE, "sample.txt", { bom: false, lineEnding: "lf" }));

  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });
}

main().catch((error: unknown) => {
  $("status").textContent = `The editor could not start: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
