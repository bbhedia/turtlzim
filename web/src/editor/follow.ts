import { Facet } from "@codemirror/state";
import type { LinkInfo } from "./links";

/**
 * What following a link or a tag does (a click with Ctrl or Cmd): the options the editor was made with, kept where what the
 * editor draws for itself (the grid of a table has links and tags in its cells) can reach them.
 */
export interface Follow {
  link?: (link: LinkInfo) => void;
  tag?: (tag: string) => void;
}

export const followFacet = Facet.define<Follow, Follow>({
  combine: (values) => values[0] ?? {},
});
