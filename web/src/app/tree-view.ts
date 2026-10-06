// The page tree in the sidebar. A flat list of nodes (name, depth, whether it has text, how many
// pages lie directly below it) goes in; a tree you can fold and walk with the keyboard comes out,
// with the roles and states a screen reader expects of one.
import type { TreeNode } from "../notebook-core";
import { clear, h } from "./dom";

export interface TreeViewOptions {
  /** A page (or section) was chosen. */
  onOpen: (name: string) => void;
  /** The set of folded sections changed (to be remembered). */
  onFoldChange?: (folded: Set<string>) => void;
}

const keyOf = (name: string) => name.toLowerCase();

export class TreeView {
  readonly element: HTMLElement;
  private nodes: TreeNode[] = [];
  private folded: Set<string>;
  private current: string | null = null;
  private visible: Array<{ node: TreeNode; row: HTMLElement }> = [];
  private focusKey: string | null = null;

  constructor(
    private readonly options: TreeViewOptions,
    folded: Iterable<string> = [],
  ) {
    this.folded = new Set(folded);
    this.element = h("div", { class: "tree", role: "tree", "aria-label": "Pages" });
    this.element.addEventListener("keydown", (event) => this.onKey(event));
  }

  setNodes(nodes: TreeNode[]): void {
    this.nodes = nodes;
    this.render();
  }

  /** Mark a page as the one shown, and unfold the sections above it. */
  setCurrent(name: string | null): void {
    this.current = name;
    if (name) {
      const parts = name.split(":");
      let changed = false;
      for (let n = 1; n < parts.length; n++) changed = this.folded.delete(keyOf(parts.slice(0, n).join(":"))) || changed;
      if (changed) this.options.onFoldChange?.(this.folded);
    }
    this.focusKey = name ? keyOf(name) : this.focusKey;
    this.render();
    this.visible.find((v) => keyOf(v.node.name) === this.focusKey)?.row.scrollIntoView({ block: "nearest" });
  }

  /** Fold every section (or, with false, unfold them all). */
  foldAll(fold: boolean): void {
    this.folded = new Set(fold ? this.nodes.filter((n) => n.children > 0).map((n) => keyOf(n.name)) : []);
    this.options.onFoldChange?.(this.folded);
    this.render();
  }

  /** Choose which sections are folded: the keys given, or (with null) every section that has pages below it. */
  setFolded(keys: Iterable<string> | null): void {
    this.folded = keys ? new Set(keys) : new Set(this.nodes.filter((n) => n.children > 0).map((n) => keyOf(n.name)));
    this.render();
  }

  private toggle(node: TreeNode): void {
    const key = keyOf(node.name);
    if (this.folded.has(key)) this.folded.delete(key);
    else this.folded.add(key);
    this.options.onFoldChange?.(this.folded);
    this.focusKey = key;
    this.render();
    this.focusRow(key);
  }

  private render(): void {
    // Rebuilding the rows must not make the keyboard lose its place: put focus back on the same row.
    const hadFocus = this.element.contains(document.activeElement);
    clear(this.element);
    this.visible = [];
    let hiddenBelow: number | null = null;
    for (const node of this.nodes) {
      if (hiddenBelow !== null) {
        if (node.depth > hiddenBelow) continue;
        hiddenBelow = null;
      }
      const key = keyOf(node.name);
      const hasChildren = node.children > 0;
      const isFolded = hasChildren && this.folded.has(key);
      if (isFolded) hiddenBelow = node.depth;
      const title = node.name.split(":").pop() ?? node.name;

      const chevron = hasChildren
        ? h("button", { class: "chevron", type: "button", tabindex: "-1", "aria-label": isFolded ? `Unfold ${title}` : `Fold ${title}`, on: { click: (e) => { e.stopPropagation(); this.toggle(node); } } }, h("span", { class: isFolded ? "caret folded" : "caret", "aria-hidden": "true" }))
        : h("span", { class: "chevron spacer", "aria-hidden": "true" });
      const row = h(
        "div",
        {
          class: `row${node.hasPage ? "" : " section"}${key === (this.current ? keyOf(this.current) : null) ? " current" : ""}`,
          role: "treeitem",
          "aria-level": node.depth + 1,
          "aria-expanded": hasChildren ? String(!isFolded) : undefined,
          "aria-selected": key === (this.current ? keyOf(this.current) : null) ? "true" : "false",
          "data-name": node.name,
          tabindex: key === this.focusKey ? "0" : "-1",
          style: `--depth: ${node.depth}`,
          title: node.name,
          on: { click: () => { this.focusKey = key; this.options.onOpen(node.name); } },
        },
        chevron,
        h("span", { class: "label", text: title }),
      );
      this.element.append(row);
      this.visible.push({ node, row });
    }
    // the tree needs one tab stop: the focused row, or else the first
    const focused = this.visible.find((v) => keyOf(v.node.name) === this.focusKey);
    if (!focused && this.visible[0]) this.visible[0].row.tabIndex = 0;
    if (hadFocus) (focused ?? this.visible[0])?.row.focus({ preventScroll: true });
  }

  private focusRow(key: string): void {
    const found = this.visible.find((v) => keyOf(v.node.name) === key);
    if (!found) return;
    for (const v of this.visible) v.row.tabIndex = v === found ? 0 : -1;
    this.focusKey = key;
    found.row.focus();
  }

  private onKey(event: KeyboardEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>(".row");
    if (!target) return;
    const index = this.visible.findIndex((v) => v.row === target);
    const entry = this.visible[index];
    if (!entry) return;
    const move = (to: number) => {
      const next = this.visible[Math.max(0, Math.min(this.visible.length - 1, to))];
      if (next) this.focusRow(keyOf(next.node.name));
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(this.visible.length - 1);
        break;
      case "ArrowRight":
        if (entry.node.children > 0 && this.folded.has(keyOf(entry.node.name))) this.toggle(entry.node);
        else if (entry.node.children > 0) move(index + 1);
        break;
      case "ArrowLeft":
        if (entry.node.children > 0 && !this.folded.has(keyOf(entry.node.name))) this.toggle(entry.node);
        else {
          // to the section this page is in: the nearest row above that is one level up
          for (let i = index - 1; i >= 0; i--) {
            if ((this.visible[i] as { node: TreeNode }).node.depth < entry.node.depth) {
              move(i);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        this.options.onOpen(entry.node.name);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
