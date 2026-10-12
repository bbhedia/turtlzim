// The tags of the open notebook, in the sidebar: each is a way to the pages that write it.
import type { TagInfo } from "../notebook-core";
import { clear, h } from "./dom";

/** How many tags the list shows: a page can write thousands, and the list is drawn again whenever a page is saved. */
export const TAGS_SHOWN = 500;

export class TagsPanel {
  readonly element: HTMLDetailsElement;
  private readonly count = h("span", { class: "count" });
  private readonly list = h("ul", { class: "panel-list tags-list" });
  /** What the list shows now (the tags and how many pages each has), to leave it alone when a save changed none of it. */
  private shown: string | null = null;

  /** `pick` is given the name of the tag that was chosen (without its `@`). */
  constructor(
    private readonly pick: (tag: string) => void,
    open = false,
  ) {
    this.element = h("details", { class: "panel tags", open }, h("summary", {}, "Tags ", this.count), this.list);
    this.show([]);
  }

  show(tags: TagInfo[]): void {
    const listed = tags.slice(0, TAGS_SHOWN);
    // (drawn again only when it differs: a list that is rebuilt under a person's hands loses the focus and the place in it)
    const signature = `${tags.length}\n${listed.map((tag) => `${tag.name}\t${tag.pages.length}`).join("\n")}`;
    if (signature === this.shown) return;
    this.shown = signature;
    clear(this.list);
    this.count.textContent = tags.length ? `(${tags.length})` : "";
    if (tags.length === 0) {
      this.list.append(h("li", { class: "none", text: "No page has a tag yet. Write @word in a page." }));
      return;
    }
    for (const tag of listed) {
      const pages = tag.pages.length;
      this.list.append(
        h(
          "li",
          {},
          h(
            "button",
            { type: "button", class: "link-button", title: `${pages} ${pages === 1 ? "page" : "pages"} with @${tag.name}`, on: { click: () => this.pick(tag.name) } },
            h("span", { class: "tag-name", text: `@${tag.name}` }),
            h("span", { class: "count", text: ` (${pages})` }),
          ),
        ),
      );
    }
    if (tags.length > listed.length) {
      this.list.append(h("li", { class: "none", text: `${tags.length - listed.length} more: search for @ and the tag to find its pages.` }));
    }
  }
}
