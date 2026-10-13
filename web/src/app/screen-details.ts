// Screen and keyboard details: a small panel on top of the page that says, live, what the browser reports about the screen (the
// visual viewport, whether a keyboard is thought to be up, what has the focus, the last touches). For a phone that does something
// that was not expected: a screenshot of this says what the browser does, which a description can't. It shows nothing of a
// notebook: numbers, and the kinds of elements (`div.cm-content`), never what they hold or the names of pages.
import { h } from "./dom";

export interface ScreenDetails {
  close(): void;
}

/** What an element is, not what it holds: `input#search`, `div.cm-line`. */
function kind(element: Element | EventTarget | null): string {
  if (!(element instanceof Element)) return "none";
  const id = element.id ? `#${element.id}` : "";
  const classes = [...element.classList].slice(0, 2).map((c) => `.${c}`).join("");
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

const flag = (on: boolean): string => (on ? "1" : "0");
const media = (query: string): boolean => typeof matchMedia === "function" && matchMedia(query).matches;

/** The platform part of the browser's description of itself (`iPhone; CPU iPhone OS 17_4 like Mac OS X`), which says what to expect. */
function platform(): string {
  return /\(([^)]*)\)/.exec(navigator.userAgent)?.[1] ?? "?";
}

const LAST = 7;

/** Put the panel up; `closed` is told when it is put away (by its button, or by `close`). */
export function showScreenDetails(app: () => HTMLElement | null, closed: () => void): ScreenDetails {
  const events: string[] = [];
  const text = h("pre", { class: "screen-details-text" });
  let atBottom = false;
  const move = h("button", { type: "button", class: "screen-details-button", text: "bottom" });
  const close = h("button", { type: "button", class: "screen-details-button", text: "close" });
  const panel = h("div", { class: "screen-details", role: "status", "aria-label": "Screen and keyboard details" }, h("div", { class: "screen-details-bar" }, h("strong", { text: "Screen and keyboard details" }), move, close), text);
  document.body.append(panel);

  const draw = (): void => {
    const view = window.visualViewport;
    const root = document.documentElement;
    const node = app();
    const lines = [
      `${platform()}`,
      `window ${innerWidth}×${innerHeight}  visual ${view ? `${Math.round(view.width)}×${Math.round(view.height)}  scale ${Math.round(view.scale * 100) / 100}  top ${Math.round(view.offsetTop)}` : "none"}`,
      `--visible-height ${root.style.getPropertyValue("--visible-height") || "-"}  --visible-top ${root.style.getPropertyValue("--visible-top") || "-"}`,
      `coarse ${flag(media("(pointer: coarse)"))}  hover ${flag(media("(hover: hover)"))}  landscape ${flag(media("(orientation: landscape)"))}  installed ${flag(media("(display-mode: standalone)"))}  dark ${flag(media("(prefers-color-scheme: dark)"))}`,
      `editing ${flag(node?.classList.contains("editing") ?? false)}  keyboard ${flag(node?.classList.contains("keyboard") ?? false)}  bar ${node?.dataset.formatbar ?? "-"}  tree ${node?.dataset.sidebar ?? "-"}`,
      `focus ${kind(document.activeElement)}`,
      ...events.slice(-LAST).map((e) => `· ${e}`),
    ];
    text.textContent = lines.join("\n");
  };
  let pending = false;
  const redraw = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      draw();
    });
  };
  const note = (what: string): void => {
    events.push(what);
    if (events.length > 40) events.splice(0, events.length - 40);
    redraw();
  };

  const listeners: Array<[EventTarget, string, EventListener]> = [];
  const listen = (target: EventTarget | null | undefined, type: string, handler: EventListener, capture = true): void => {
    if (!target) return;
    target.addEventListener(type, handler, capture);
    listeners.push([target, type, handler]);
  };
  listen(document, "pointerdown", (event) => note(`pointerdown ${(event as PointerEvent).pointerType} ${kind(event.target)}`));
  listen(document, "click", (event) => note(`click ${kind(event.target)}`));
  listen(document, "focusin", (event) => note(`focus ${kind(event.target)}`));
  listen(document, "focusout", (event) => note(`blur ${kind(event.target)}`));
  listen(window.visualViewport, "resize", () => note(`visual resize ${Math.round(window.visualViewport?.height ?? 0)}`), false);
  listen(window.visualViewport, "scroll", () => note(`visual scroll top ${Math.round(window.visualViewport?.offsetTop ?? 0)}`), false);
  listen(window, "orientationchange", () => note("orientation changed"), false);
  listen(window, "resize", () => note(`window resize ${innerWidth}×${innerHeight}`), false);
  // (the classes that say that the text has the keyboard, and that a keyboard is up, are the app's: what they are is part of what is reported)
  const watched = app();
  const observer = new MutationObserver(() => {
    note(`app ${watched?.classList.contains("editing") ? "editing" : "reading"}${watched?.classList.contains("keyboard") ? " keyboard" : ""}`);
  });
  if (watched) observer.observe(watched, { attributes: true, attributeFilter: ["class"] });

  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, false);
    observer.disconnect();
    panel.remove();
    closed();
  };
  close.addEventListener("click", stop);
  move.addEventListener("click", () => {
    atBottom = !atBottom;
    panel.classList.toggle("at-bottom", atBottom);
    move.textContent = atBottom ? "top" : "bottom";
  });
  draw();
  return { close: stop };
}
