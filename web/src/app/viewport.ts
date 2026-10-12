// The part of the screen that can be seen. On a phone the on-screen keyboard covers the bottom of it without telling the page's
// layout (the visual viewport shrinks, the layout viewport does not), so an app that is as tall as the page has its bottom bar,
// and the line being typed on, under the keyboard. The app is made as tall as what can be seen instead, and (where a browser
// pans the visual viewport over the page to bring the focused field into view) moved to where it is.

/** The pieces of `window.visualViewport` that this reads (and what a test gives in its place). */
export interface VisibleArea {
  height: number;
  width: number;
  scale: number;
  offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

/** What the app is told after the visible area changed. */
export interface VisibleChange {
  /** Whether a part of the screen as big as an on-screen keyboard is gone from the bottom of it. */
  keyboard: boolean;
}

/** How much shorter than the tallest it has been the visible area has to be for a keyboard to be what took the rest (the address bar that hides as a page is scrolled is about 60 pixels). */
export const KEYBOARD_MIN = 120;

/** The height the app should be, or null to leave it as the page's own: when the page is zoomed in the visible part is a piece of it, and the app is not made as small as that. */
export function visibleHeight(area: Pick<VisibleArea, "height" | "scale">): number | null {
  return area.scale > 1.01 || !(area.height > 0) ? null : Math.round(area.height);
}

/**
 * Keep `--visible-height` on `root` what `visualViewport` says (and `--visible-top`, with `data-panned`, when the browser has moved the
 * visual viewport down the page), while it is a screen that is touched: a fine pointer has no keyboard that covers it, and a window
 * resized by hand is the layout's own business. `changed` is told after each change, to bring the caret into view in the smaller
 * space, and whether a keyboard is up. Returns what stops it.
 */
export function trackVisibleHeight(root: HTMLElement, changed: (change: VisibleChange) => void, win: { visualViewport?: VisibleArea | null; matchMedia(query: string): { matches: boolean } } = window): () => void {
  const area = win.visualViewport;
  if (!area) return () => undefined;
  let last: string | null = null;
  // the tallest the area has been at this width (a turned screen is another width): what no keyboard takes anything from
  let tallest = 0;
  let width = 0;
  const clear = (): void => {
    root.style.removeProperty("--visible-height");
    root.style.removeProperty("--visible-top");
    root.removeAttribute("data-panned");
  };
  const apply = (): void => {
    if (!win.matchMedia("(pointer: coarse)").matches) {
      clear();
      last = null;
      return;
    }
    const height = visibleHeight(area);
    if (height === null) return;
    if (area.width !== width) {
      width = area.width;
      tallest = 0;
    }
    tallest = Math.max(tallest, height);
    const top = Math.max(0, Math.round(area.offsetTop));
    const keyboard = tallest - height >= KEYBOARD_MIN;
    const key = `${height} ${top} ${keyboard}`;
    if (key === last) return;
    last = key;
    root.style.setProperty("--visible-height", `${height}px`);
    if (top > 0) {
      root.style.setProperty("--visible-top", `${top}px`);
      root.setAttribute("data-panned", "");
    } else {
      root.style.removeProperty("--visible-top");
      root.removeAttribute("data-panned");
    }
    changed({ keyboard });
  };
  area.addEventListener("resize", apply);
  area.addEventListener("scroll", apply);
  apply();
  return () => {
    area.removeEventListener("resize", apply);
    area.removeEventListener("scroll", apply);
    clear();
  };
}
