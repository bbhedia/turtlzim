// What the formatting bar asks of the editor (where the selection is: in bold, in a list, in a heading, whether Shift-Tab would
// do something), and how the app follows the part of the screen that can be seen (an on-screen keyboard covers the rest).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { canOutdent, headingLevelHere, listKindHere, styleActive } from "../src/editor/commands";
import { KEYBOARD_MIN, trackVisibleHeight, visibleHeight } from "../src/app/viewport";
import type { VisibleArea, VisibleChange } from "../src/app/viewport";
import { Kind } from "../src/kinds";
import { initZimSync } from "../src/zim";
import { stateOf } from "./helpers/marked";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

describe("whether the selection is in a style", () => {
  it("is so for a caret or a selection inside such a construct, and for a caret touching its markers", () => {
    expect(styleActive(stateOf("say **bo¦ld** now"), Kind.Bold)).toBe(true);
    expect(styleActive(stateOf("say **⟨bold⟩** now"), Kind.Bold)).toBe(true);
    expect(styleActive(stateOf("say **bold**¦ now"), Kind.Bold)).toBe(true);
    expect(styleActive(stateOf("say ¦**bold** now"), Kind.Bold)).toBe(true);
  });

  it("is not so outside one, or for a selection that goes beyond it, or for another style", () => {
    expect(styleActive(stateOf("say bo¦ld now"), Kind.Bold)).toBe(false);
    expect(styleActive(stateOf("⟨say **bold**⟩ now"), Kind.Bold)).toBe(false);
    expect(styleActive(stateOf("**bo⟨ld** no⟩w"), Kind.Bold)).toBe(false);
    expect(styleActive(stateOf("say **bo¦ld** now"), Kind.Italic)).toBe(false);
    expect(styleActive(stateOf("say **bo¦ld** now"), Kind.Strike)).toBe(false);
  });

  it("is so for each style that holds the caret, when they are inside one another", () => {
    const state = stateOf("**a //b¦// c**");
    expect(styleActive(state, Kind.Bold)).toBe(true);
    expect(styleActive(state, Kind.Italic)).toBe(true);
    expect(styleActive(stateOf("**a //b// c¦**"), Kind.Italic)).toBe(false);
  });

  it("knows each style the bar has a button for", () => {
    for (const [kind, text] of [
      [Kind.Bold, "**x¦**"],
      [Kind.Italic, "//x¦//"],
      [Kind.Underline, "__x¦__"],
      [Kind.Strike, "~~x¦~~"],
      [Kind.InlineVerbatim, "''x¦''"],
    ] as const) {
      expect(styleActive(stateOf(text), kind), text).toBe(true);
    }
  });
});

describe("the level of the heading that the caret's line is", () => {
  it("is 1 for the biggest to 5 for the smallest, by the number of = signs", () => {
    expect(headingLevelHere(stateOf("====== T¦itle ======\ntext"))).toBe(1);
    expect(headingLevelHere(stateOf("===== T¦ =====\n"))).toBe(2);
    expect(headingLevelHere(stateOf("==== T¦ ====\n"))).toBe(3);
    expect(headingLevelHere(stateOf("=== T¦ ===\n"))).toBe(4);
    expect(headingLevelHere(stateOf("== T¦ ==\n"))).toBe(5);
  });

  it("is that of the line the caret is on, wherever in the line, and 0 on any other line", () => {
    expect(headingLevelHere(stateOf("¦intro\n\n== Title ==\nbody\n"))).toBe(0);
    expect(headingLevelHere(stateOf("intro\n\n¦== Title ==\nbody\n"))).toBe(5);
    expect(headingLevelHere(stateOf("intro\n\n== Title ==¦\nbody\n"))).toBe(5);
    expect(headingLevelHere(stateOf("intro\n\n== Title ==\nbo¦dy\n"))).toBe(0);
  });

  it("is 0 for a line that only looks like a heading: in code, in a table", () => {
    expect(headingLevelHere(stateOf("'''\n====== ¦x ======\n'''\n"))).toBe(0);
    expect(headingLevelHere(stateOf("| ====== ¦x ====== |\n|---|\n"))).toBe(0);
  });

  it("is 0 on an empty page", () => {
    expect(headingLevelHere(stateOf("¦"))).toBe(0);
  });
});

describe("what kind of list item the caret's line is", () => {
  const kind = (marked: string) => listKindHere(stateOf(marked));

  it("tells a bullet, a number (or a letter) and a checkbox (of any state) apart", () => {
    expect(kind("* it¦em")).toBe("bullet");
    expect(kind("1. on¦e")).toBe("number");
    expect(kind("a. on¦e")).toBe("number");
    expect(kind("B. on¦e")).toBe("number");
    for (const box of ["[ ]", "[*]", "[x]", "[>]", "[<]"]) expect(kind(`${box} to ¦do`), box).toBe("checkbox");
  });

  it("is that of the item, however deep, and wherever in its line the caret is", () => {
    expect(kind("\t\t* ne¦sted")).toBe("bullet");
    expect(kind("¦* start")).toBe("bullet");
    expect(kind("* end¦")).toBe("bullet");
    expect(kind("[ ] a\n\t* b¦")).toBe("bullet");
  });

  it("is null on a line that is no item: text, a heading, an empty line", () => {
    expect(kind("just te¦xt")).toBeNull();
    expect(kind("== H¦ ==")).toBeNull();
    expect(kind("* a\n¦\n* b")).toBeNull();
    expect(kind("¦")).toBeNull();
  });
});

describe("whether Shift-Tab would take a line out", () => {
  it("is so when a line of the selection is indented, and not when none is", () => {
    expect(canOutdent(stateOf("\t* ne¦sted"))).toBe(true);
    expect(canOutdent(stateOf("* to¦p"))).toBe(false);
    expect(canOutdent(stateOf("⟨* a\n\t* b\n* c⟩"))).toBe(true);
    expect(canOutdent(stateOf("⟨* a\n* c⟩"))).toBe(false);
  });

  it("does not count a line that the selection only reaches the start of", () => {
    expect(canOutdent(stateOf("⟨* a\n⟩\t* b"))).toBe(false);
  });
});

describe("the height that the app is made", () => {
  it("is what can be seen, in whole pixels", () => {
    expect(visibleHeight({ height: 500.4, scale: 1 })).toBe(500);
    expect(visibleHeight({ height: 499.6, scale: 1 })).toBe(500);
    expect(visibleHeight({ height: 700, scale: 1.005 })).toBe(700);
  });

  it("is left to the page when zoomed in (what can be seen is then a piece of it), or when there is nothing to go by", () => {
    expect(visibleHeight({ height: 300, scale: 2 })).toBeNull();
    expect(visibleHeight({ height: 300, scale: 1.02 })).toBeNull();
    expect(visibleHeight({ height: 0, scale: 1 })).toBeNull();
    expect(visibleHeight({ height: Number.NaN, scale: 1 })).toBeNull();
    expect(visibleHeight({ height: -5, scale: 1 })).toBeNull();
  });
});

/** A visual viewport that a test moves, a root that remembers what is set on it, and a window that says whether the screen is touched. */
function screen(options: { coarse?: boolean; height?: number; width?: number } = {}) {
  const listeners: Record<"resize" | "scroll", Array<() => void>> = { resize: [], scroll: [] };
  const area: VisibleArea = {
    height: options.height ?? 800,
    width: options.width ?? 390,
    scale: 1,
    offsetTop: 0,
    addEventListener: (type, listener) => void listeners[type].push(listener),
    removeEventListener: (type, listener) => void listeners[type].splice(listeners[type].indexOf(listener), 1),
  };
  const properties = new Map<string, string>();
  const attributes = new Set<string>();
  const root = {
    style: { setProperty: (name: string, value: string) => void properties.set(name, value), removeProperty: (name: string) => void properties.delete(name) },
    setAttribute: (name: string) => void attributes.add(name),
    removeAttribute: (name: string) => void attributes.delete(name),
  } as unknown as HTMLElement;
  const win = { visualViewport: area, matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" ? (win.coarse as boolean) : false }), coarse: options.coarse ?? true };
  const changes: VisibleChange[] = [];
  const stop = trackVisibleHeight(root, (change) => changes.push(change), win);
  const move = (change: Partial<VisibleArea>, event: "resize" | "scroll" = "resize") => {
    Object.assign(area, change);
    for (const listener of [...listeners[event]]) listener();
  };
  return { area, properties, attributes, changes, move, stop, listeners, win };
}

describe("following the part of the screen that can be seen", () => {
  it("makes the app as tall as that on a touch screen, and tells whether a keyboard took the rest", () => {
    const s = screen();
    expect(s.properties.get("--visible-height")).toBe("800px");
    expect(s.changes).toEqual([{ keyboard: false }]);
    s.move({ height: 470 });
    expect(s.properties.get("--visible-height")).toBe("470px");
    expect(s.changes.at(-1)).toEqual({ keyboard: true });
    s.move({ height: 800 });
    expect(s.properties.get("--visible-height")).toBe("800px");
    expect(s.changes.at(-1)).toEqual({ keyboard: false });
  });

  it("does not take the address bar that hides as a page is scrolled for a keyboard", () => {
    const s = screen();
    s.move({ height: 800 - (KEYBOARD_MIN - 1) });
    expect(s.changes.at(-1)).toEqual({ keyboard: false });
    s.move({ height: 800 - KEYBOARD_MIN });
    expect(s.changes.at(-1)).toEqual({ keyboard: true });
    // (and what is taller than it was becomes the height to compare with: the bar went away)
    s.move({ height: 860 });
    s.move({ height: 860 - KEYBOARD_MIN + 1 });
    expect(s.changes.at(-1)).toEqual({ keyboard: false });
  });

  it("says nothing when nothing changed, and leaves a page that is zoomed in alone", () => {
    const s = screen();
    const told = s.changes.length;
    s.move({});
    s.move({}, "scroll");
    expect(s.changes.length).toBe(told);
    s.move({ height: 300, scale: 2 });
    expect(s.properties.get("--visible-height")).toBe("800px");
    expect(s.changes.length).toBe(told);
  });

  it("takes a turned screen for a new height to compare with", () => {
    const s = screen();
    s.move({ height: 470 });
    expect(s.changes.at(-1)).toEqual({ keyboard: true });
    s.move({ height: 390, width: 844 });
    expect(s.properties.get("--visible-height")).toBe("390px");
    expect(s.changes.at(-1)).toEqual({ keyboard: false });
    // (also when the height is the same: with the keyboard up, the screen is turned, and the height is the tallest there is for that width)
    const t = screen();
    t.move({ height: 470 });
    expect(t.changes.at(-1)).toEqual({ keyboard: true });
    t.move({ width: 844 });
    expect(t.changes.at(-1)).toEqual({ keyboard: false });
  });

  it("moves the app down with the visible area where the browser has panned it, and back", () => {
    const s = screen();
    expect(s.attributes.has("data-panned")).toBe(false);
    s.move({ height: 470, offsetTop: 120.4 }, "scroll");
    expect(s.properties.get("--visible-top")).toBe("120px");
    expect(s.attributes.has("data-panned")).toBe(true);
    s.move({ offsetTop: 0 }, "scroll");
    expect(s.properties.has("--visible-top")).toBe(false);
    expect(s.attributes.has("data-panned")).toBe(false);
  });

  it("does nothing on a screen that is not touched, and gives the page back its own height if it stops being one", () => {
    const fine = screen({ coarse: false });
    expect(fine.properties.size).toBe(0);
    expect(fine.changes).toEqual([]);
    fine.move({ height: 470 });
    expect(fine.properties.size).toBe(0);
    const s = screen();
    expect(s.properties.size).toBe(1);
    s.win.coarse = false;
    s.move({ height: 700 });
    expect(s.properties.size).toBe(0);
    expect(s.attributes.size).toBe(0);
  });

  it("stops: no more changes, and the page has its own height again", () => {
    const s = screen();
    s.move({ height: 470 });
    const told = s.changes.length;
    s.stop();
    expect(s.listeners.resize.length + s.listeners.scroll.length).toBe(0);
    expect(s.properties.size).toBe(0);
    s.move({ height: 800 });
    expect(s.changes.length).toBe(told);
    expect(s.properties.size).toBe(0);
  });

  it("is nothing where there is no visual viewport", () => {
    const stop = trackVisibleHeight({} as HTMLElement, () => undefined, { visualViewport: null, matchMedia: () => ({ matches: true }) });
    expect(stop()).toBeUndefined();
  });
});
