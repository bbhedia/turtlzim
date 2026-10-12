// The formatting bar: a row of buttons for what the keys do, for a screen that has none (a phone), or for anyone who
// prefers to press a button. It acts on the editor like the keys do (the same commands), shows what the selection is in
// (bold, a list, a heading, a link), and never takes the focus from the text: on a phone, that would close the
// on-screen keyboard at every press.
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import type { EditorState, StateCommand } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Kind } from "../kinds";
import { WRAPPERS, canOutdent, headingLevelHere, indentLess, indentMore, insertLink, listKindHere, setHeading, styleActive, toggleList, toggleWrap } from "./commands";
import { linkAt } from "./links";
import type { LinkInfo } from "./links";
import { insertTable } from "./table-commands";

/** What the bar needs from the app that has it. */
export interface FormatBarHost {
  /** Follow a link (the bar offers it while the caret is in one). */
  follow?: (link: LinkInfo) => void;
  /** Attach files or a picture (the app opens its chooser, which on a phone offers the camera). */
  attach?: () => void;
}

/** A drawing for a button, in a square 24 wide: lines (and filled dots, where a shape says so) in the colour of the text. */
type Shape = [tag: "path" | "rect" | "circle", attributes: Record<string, string>];
const FILLED = { fill: "currentColor", stroke: "none" };
const DRAWINGS: Record<string, Shape[]> = {
  undo: [["path", { d: "M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1" }]],
  redo: [["path", { d: "M15 7l5 5-5 5M20 12h-9a6 6 0 0 0-6 6v1" }]],
  headings: [["path", { d: "M6 5v14M18 5v14M6 12h12" }]],
  bullet: [["circle", { cx: "5", cy: "7", r: "1.4", ...FILLED }], ["circle", { cx: "5", cy: "12", r: "1.4", ...FILLED }], ["circle", { cx: "5", cy: "17", r: "1.4", ...FILLED }], ["path", { d: "M10 7h10M10 12h10M10 17h10" }]],
  checkbox: [["rect", { x: "4", y: "4", width: "16", height: "16", rx: "2" }], ["path", { d: "m8 12 3 3 5-6" }]],
  link: [["path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }]],
  open: [["path", { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }]],
  indent: [["path", { d: "M4 6h16M11 12h9M4 18h16M4 9l3 3-3 3" }]],
  outdent: [["path", { d: "M4 6h16M11 12h9M4 18h16M7 9l-3 3 3 3" }]],
  table: [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 10h18M3 15h18M9 4v16M15 4v16" }]],
  attach: [["path", { d: "M20 11.5 12 19.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" }]],
};

function drawing(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("format-drawing");
  for (const [tag, attributes] of DRAWINGS[name] ?? []) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

interface Button {
  id: string;
  /** What the button shows when it has no drawing. */
  label: string;
  /** What it does, in words: its tooltip and the name a screen reader gives it. */
  title: string;
  run: (view: EditorView) => void;
  /** Whether it is on where the selection is (it is drawn pressed). */
  on?: (state: EditorState) => boolean;
  /** Whether it can be used (it is dimmed when it can't). */
  can?: (state: EditorState) => boolean;
  /** Whether it is there at all (the button to open a link takes the place of the one that makes a link while the caret is in one). */
  when?: (state: EditorState) => boolean;
}

const style = (kind: number) => (state: EditorState) => styleActive(state, kind);
const listIs = (kind: "bullet" | "number" | "checkbox") => (state: EditorState) => listKindHere(state) === kind;
/** Run a state command on a view, as a key would. */
const key = (command: StateCommand) => (view: EditorView) => void command(view);
const inLink = (state: EditorState): boolean => linkAt(state, state.selection.main.head) !== null;

/** In the order of use on a phone, where the first seven or eight are all that can be seen without moving the bar. */
function buttons(host: FormatBarHost, toggleHeadings: () => void): Button[] {
  const follows = host.follow !== undefined;
  return [
    { id: "undo", label: "Undo", title: "Undo the last change", run: (view) => void undo(view), can: (state) => undoDepth(state) > 0 },
    { id: "redo", label: "Redo", title: "Do again what was undone", run: (view) => void redo(view), can: (state) => redoDepth(state) > 0 },
    { id: "bold", label: "B", title: "Bold", run: key(toggleWrap(WRAPPERS.bold)), on: style(Kind.Bold) },
    { id: "italic", label: "I", title: "Italic", run: key(toggleWrap(WRAPPERS.italic)), on: style(Kind.Italic) },
    { id: "headings", label: "Heading", title: "Make the line a heading, or plain text again", run: toggleHeadings, on: (state) => headingLevelHere(state) > 0 },
    { id: "bullet", label: "Bullets", title: "A list of bullets", run: key(toggleList("bullet")), on: listIs("bullet") },
    { id: "checkbox", label: "To do", title: "A list of things to do (a tap on a box ticks it)", run: key(toggleList("checkbox")), on: listIs("checkbox") },
    { id: "link", label: "Link", title: "Make a link to a page (type [[ and a few letters of its name to choose from the pages)", run: key(insertLink), when: (state) => !(follows && inLink(state)) },
    { id: "open", label: "Open", title: "Go to the page this link leads to", run: (view) => { const link = linkAt(view.state, view.state.selection.main.head); if (link) host.follow?.(link); }, when: (state) => follows && inLink(state) },
    { id: "number", label: "1.", title: "A numbered list", run: key(toggleList("number")), on: listIs("number") },
    { id: "indent", label: "Indent", title: "Indent: move the list item in one level", run: key(indentMore) },
    { id: "outdent", label: "Outdent", title: "Outdent: move the list item out one level", run: key(indentLess), can: canOutdent },
    { id: "underline", label: "U", title: "Underline", run: key(toggleWrap(WRAPPERS.underline)), on: style(Kind.Underline) },
    { id: "strike", label: "S", title: "Strike through", run: key(toggleWrap(WRAPPERS.strike)), on: style(Kind.Strike) },
    { id: "code", label: "</>", title: "Code", run: key(toggleWrap(WRAPPERS.code)), on: style(Kind.InlineVerbatim) },
    { id: "table", label: "Table", title: "Insert a table here", run: key(insertTable()) },
    ...(host.attach ? [{ id: "attach", label: "Attach", title: "Attach a file or a picture to this page", run: () => host.attach?.() }] : []),
  ];
}

const HEADINGS: Array<{ level: number; label: string; title: string }> = [
  { level: 1, label: "1", title: "Heading 1, the biggest" },
  { level: 2, label: "2", title: "Heading 2" },
  { level: 3, label: "3", title: "Heading 3" },
  { level: 4, label: "4", title: "Heading 4" },
  { level: 5, label: "5", title: "Heading 5, the smallest" },
  { level: 0, label: "Plain", title: "Plain text, not a heading" },
];

export interface FormatBar {
  readonly element: HTMLElement;
  /** Draw what is on and what can be done for `state` (the editor's, after any change or move of the selection). */
  refresh(state: EditorState): void;
}

/**
 * Make the bar for the editor that `view()` gives. The buttons are real buttons and are reached by Tab like any, one
 * stop for the whole bar and the arrows between them; a press does what its title says and gives the focus back to the text.
 */
export function createFormatBar(view: () => EditorView, host: FormatBarHost = {}): FormatBar {
  const bar = document.createElement("div");
  bar.className = "format-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Formatting");
  const main = document.createElement("div");
  main.className = "format-row";
  const headingRow = document.createElement("div");
  headingRow.className = "format-row format-headings";
  headingRow.hidden = true;
  headingRow.setAttribute("role", "group");
  headingRow.setAttribute("aria-label", "Heading level");
  bar.append(headingRow, main);

  /** Buttons never take the focus: the text keeps it (and on a phone the keyboard stays). The press acts on click. */
  const make = (label: string, title: string, act: () => void, drawn?: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "format-button";
    if (drawn !== undefined && DRAWINGS[drawn]) button.append(drawing(drawn));
    else button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.tabIndex = -1;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      act();
      view().focus();
    });
    return button;
  };

  const toggleHeadings = () => {
    const open = headingRow.hidden;
    headingRow.hidden = !open;
    headingButton?.setAttribute("aria-expanded", String(open));
  };
  const specs = buttons(host, toggleHeadings);
  const made = specs.map((spec) => {
    const button = make(spec.label, spec.title, () => spec.run(view()), spec.id);
    button.dataset.id = spec.id;
    button.classList.add(`format-${spec.id}`);
    return { spec, button };
  });
  const headingButton = made.find((m) => m.spec.id === "headings")?.button;
  headingButton?.setAttribute("aria-expanded", "false");
  made.forEach((m) => main.append(m.button));
  const headingButtons = HEADINGS.map((h) => {
    const button = make(h.label, h.title, () => {
      setHeading(h.level)(view());
      toggleHeadings();
    });
    button.dataset.level = String(h.level);
    headingRow.append(button);
    return { level: h.level, button };
  });

  // one stop for Tab in the bar, and the arrows between the buttons that are there
  const live = (): HTMLButtonElement[] => [...bar.querySelectorAll<HTMLButtonElement>(".format-button")].filter((b) => !b.disabled && !b.hidden && !b.closest("[hidden]"));
  bar.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    const all = live();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
    event.preventDefault();
    for (const b of bar.querySelectorAll<HTMLButtonElement>(".format-button")) b.tabIndex = -1;
    all[next]!.tabIndex = 0;
    all[next]!.focus();
  });

  const refresh = (state: EditorState): void => {
    for (const { spec, button } of made) {
      button.hidden = spec.when ? !spec.when(state) : false;
      button.disabled = (state.readOnly && spec.id !== "open") || (spec.can ? !spec.can(state) : false);
      if (spec.on) button.setAttribute("aria-pressed", String(spec.on(state)));
    }
    const level = headingLevelHere(state);
    for (const { level: l, button } of headingButtons) {
      button.disabled = state.readOnly;
      button.setAttribute("aria-pressed", String(l === level && l > 0));
    }
    // one stop for Tab: the first button that is there, unless the focus is on one already
    const all = live();
    if (!all.some((b) => b.tabIndex === 0)) {
      for (const b of bar.querySelectorAll<HTMLButtonElement>(".format-button")) b.tabIndex = -1;
      if (all[0]) all[0].tabIndex = 0;
    }
  };
  return { element: bar, refresh };
}
