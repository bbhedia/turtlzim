// Building DOM without a framework, and without ever turning text into markup: everything is set
// with `textContent` and attributes, so a page name or a note's text can't inject anything.

export type Child = Node | string | null | undefined | false;

type Props = {
  class?: string;
  text?: string;
  on?: { [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void };
  // anything else is set as an attribute (a boolean true makes a bare attribute, false or undefined none)
  [attribute: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false || value === null) continue;
    if (key === "class") element.className = String(value);
    else if (key === "text") element.textContent = String(value);
    else if (key === "on") {
      for (const [type, listener] of Object.entries(value as Record<string, EventListener>)) element.addEventListener(type, listener);
    } else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export function clear(element: Element): void {
  element.replaceChildren();
}

/** `text` with the words of `query` in `<mark>`, for showing why a search result matched. */
export function highlighted(text: string, query: string): Node[] {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (words.length === 0) return [document.createTextNode(text)];
  const lower = text.toLowerCase();
  const nodes: Node[] = [];
  let at = 0;
  while (at < text.length) {
    let best = -1;
    let bestWord = "";
    for (const word of words) {
      const found = lower.indexOf(word, at);
      if (found >= 0 && (best < 0 || found < best || (found === best && word.length > bestWord.length))) {
        best = found;
        bestWord = word;
      }
    }
    if (best < 0) break;
    if (best > at) nodes.push(document.createTextNode(text.slice(at, best)));
    nodes.push(h("mark", { text: text.slice(best, best + bestWord.length) }));
    at = best + bestWord.length;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}
