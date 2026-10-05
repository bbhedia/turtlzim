import type { KeyBinding } from "@codemirror/view";
import {
  WRAPPERS,
  indentLess,
  indentMore,
  insertLink,
  listBackspace,
  listEnter,
  setHeading,
  toggleCheckboxHere,
  toggleList,
  toggleWrap,
} from "./commands";

/**
 * The Zim editing keys. `Mod` is Ctrl, or Cmd on a Mac.
 *
 * Keys a browser reserves for itself can't be bound by a page: Ctrl+1..9 switch tabs and Ctrl+T
 * opens one, so headings are Ctrl+Alt+digit and strike-through also has Ctrl+Shift+X (Ctrl+T works
 * in the desktop and mobile shells, where nothing reserves it).
 */
export const zimKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: toggleWrap(WRAPPERS.bold), preventDefault: true },
  { key: "Mod-i", run: toggleWrap(WRAPPERS.italic), preventDefault: true },
  { key: "Mod-u", run: toggleWrap(WRAPPERS.underline), preventDefault: true },
  { key: "Mod-Shift-x", run: toggleWrap(WRAPPERS.strike), preventDefault: true },
  { key: "Mod-t", run: toggleWrap(WRAPPERS.strike), preventDefault: true },
  { key: "Mod-e", run: toggleWrap(WRAPPERS.code), preventDefault: true },
  { key: "Mod-.", run: toggleWrap(WRAPPERS.superscript), preventDefault: true },
  { key: "Mod-,", run: toggleWrap(WRAPPERS.subscript), preventDefault: true },
  { key: "Mod-k", run: insertLink, preventDefault: true },

  { key: "Mod-Alt-1", run: setHeading(1), preventDefault: true },
  { key: "Mod-Alt-2", run: setHeading(2), preventDefault: true },
  { key: "Mod-Alt-3", run: setHeading(3), preventDefault: true },
  { key: "Mod-Alt-4", run: setHeading(4), preventDefault: true },
  { key: "Mod-Alt-5", run: setHeading(5), preventDefault: true },
  { key: "Mod-Alt-0", run: setHeading(0), preventDefault: true },

  { key: "Mod-Shift-8", run: toggleList("bullet"), preventDefault: true },
  { key: "Mod-Shift-7", run: toggleList("number"), preventDefault: true },
  { key: "Mod-Shift-9", run: toggleList("checkbox"), preventDefault: true },
  // Zim's own keys for ticking a box (done / dropped), and ones that don't need function keys.
  { key: "F12", run: toggleCheckboxHere(false), preventDefault: true },
  { key: "F11", run: toggleCheckboxHere(true), preventDefault: true },
  { key: "Mod-Enter", run: toggleCheckboxHere(false), preventDefault: true },
  { key: "Mod-Shift-Enter", run: toggleCheckboxHere(true), preventDefault: true },

  // These only act inside a list (or on selected lines) and otherwise leave the key alone.
  { key: "Enter", run: listEnter },
  { key: "Backspace", run: listBackspace },
  { key: "Tab", run: indentMore },
  { key: "Shift-Tab", run: indentLess },
];
