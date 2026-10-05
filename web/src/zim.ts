// The Zim parser (core/zim-format, compiled to wasm by core/zim-wasm), as the editor uses it:
// text in, syntax spans out. The wasm has to be loaded once, before the first `highlight`:
// `await initZim()` in a browser, `initZimSync(bytes)` where the wasm bytes are already in hand
// (Node tests, or a host that fetched them itself).
import init, {
  decodePage as wasmDecodePage,
  encodePage as wasmEncodePage,
  highlight as wasmHighlight,
  initSync,
  spanCodes,
} from "./zim-wasm/zim_wasm.js";
import { checkCodes } from "./kinds";
import { Spans } from "./spans";

let ready = false;

function verify(): void {
  checkCodes(JSON.parse(spanCodes()));
  ready = true;
}

/** Load the wasm module in a browser (Vite bundles it as an asset next to the page). */
export async function initZim(): Promise<void> {
  if (ready) return;
  await init();
  verify();
}

/** Load the wasm module from bytes you already have. */
export function initZimSync(module: BufferSource | WebAssembly.Module): void {
  if (ready) return;
  initSync({ module });
  verify();
}

export function isZimReady(): boolean {
  return ready;
}

function assertReady(): void {
  if (!ready) throw new Error("the Zim wasm module isn't loaded: await initZim() first");
}

/** The syntax spans of `text` (offsets in UTF-16 units). */
export function highlight(text: string): Spans {
  assertReady();
  return new Spans(wasmHighlight(text));
}

export type LineEnding = "lf" | "crlf" | "mixed";

/**
 * A page file taken apart. `text` is what the parser and the editor work on: no byte-order mark,
 * and `\n` line endings if the file used `\r\n` throughout. `bom` and `lineEnding` are the file's
 * own properties, kept so that saving writes the file back exactly as it was read. (A "mixed"
 * file keeps its `\r` characters in `text`, since there is no single style to restore.)
 */
export interface PageFile {
  text: string;
  bom: boolean;
  lineEnding: LineEnding;
}

/** Take a page file's bytes apart. Throws if they are not UTF-8 (a Zim page always is). */
export function decodePage(bytes: Uint8Array): PageFile {
  assertReady();
  const decoded = wasmDecodePage(bytes);
  try {
    return { text: decoded.text, bom: decoded.bom, lineEnding: decoded.lineEnding as LineEnding };
  } finally {
    decoded.free();
  }
}

/** The bytes of a page file: the exact inverse of `decodePage` for text that came out of it. */
export function encodePage(file: PageFile): Uint8Array {
  assertReady();
  return wasmEncodePage(file.text, file.bom, file.lineEnding);
}
