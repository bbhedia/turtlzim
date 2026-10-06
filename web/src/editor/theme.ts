import { EditorView } from "@codemirror/view";

/**
 * How the Zim constructs look. Colors and fonts come from CSS variables (`--zim-fg`, `--zim-bg`,
 * `--zim-muted`, `--zim-link`, `--zim-tag`, `--zim-code-bg`, `--zim-border`, `--zim-selection`,
 * `--zim-font`, `--zim-mono`) that the page defines, with light defaults here, so the host decides
 * about dark mode and branding and the editor needs no stylesheet of its own.
 */
export const zimTheme = EditorView.theme({
  "&": {
    color: "var(--zim-fg, #1f2328)",
    backgroundColor: "var(--zim-bg, #ffffff)",
    fontSize: "16px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--zim-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "1rem 1.25rem", caretColor: "var(--zim-fg, #1f2328)", tabSize: "4" },
  ".cm-line": { padding: "0 .125rem" },
  ".cm-cursor": { borderLeftColor: "var(--zim-fg, #1f2328)" },
  ".cm-selectionBackground": { backgroundColor: "var(--zim-selection, #d7d4f0) !important" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--zim-selection, #b4d5ff) !important",
  },
  ".cm-specialChar": { color: "var(--zim-muted, #8c959f)" },

  // headings
  ".cm-zim-heading": { fontWeight: "700", lineHeight: "1.3" },
  ".cm-zim-h1": { fontSize: "1.9em", paddingTop: ".5em" },
  ".cm-zim-h2": { fontSize: "1.55em", paddingTop: ".4em" },
  ".cm-zim-h3": { fontSize: "1.3em", paddingTop: ".3em" },
  ".cm-zim-h4": { fontSize: "1.12em", paddingTop: ".2em" },
  ".cm-zim-h5": { fontSize: "1em", textTransform: "uppercase", letterSpacing: ".03em", color: "var(--zim-muted, #57606a)" },

  // inline styles
  ".cm-zim-bold": { fontWeight: "700" },
  ".cm-zim-italic": { fontStyle: "italic" },
  ".cm-zim-underline": { textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-zim-strike": { textDecoration: "line-through" },
  ".cm-zim-code-inline": {
    fontFamily: "var(--zim-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: ".92em",
    backgroundColor: "var(--zim-code-bg, #f0f1f3)",
    borderRadius: "4px",
    padding: "0 .25em",
  },
  ".cm-zim-sup": { verticalAlign: "super", fontSize: ".78em" },
  ".cm-zim-sub": { verticalAlign: "sub", fontSize: ".78em" },
  ".cm-zim-tag": {
    color: "var(--zim-tag, #9a6700)",
    backgroundColor: "var(--zim-tag-bg, rgba(154, 103, 0, .1))",
    borderRadius: "4px",
    padding: "0 .2em",
  },

  // links
  ".cm-zim-link, .cm-zim-url": { color: "var(--zim-link, #0b57d0)", cursor: "pointer" },
  ".cm-zim-link-display, .cm-zim-link-target, .cm-zim-url": { textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-zim-link .cm-zim-marker": { textDecoration: "none" },
  // a link to a page that doesn't exist yet
  ".cm-zim-link-missing, .cm-zim-link-missing .cm-zim-link-display, .cm-zim-link-missing .cm-zim-link-target": {
    color: "var(--zim-missing, #b4521f)",
    textDecorationStyle: "dashed",
  },

  // syntax characters, while visible
  ".cm-zim-marker, .cm-zim-list-marker": {
    color: "var(--zim-muted, #8c959f)",
    fontWeight: "400",
    fontStyle: "normal",
    textDecoration: "none",
  },
  ".cm-zim-image-source, .cm-zim-anchor-source, .cm-zim-rule-source": { color: "var(--zim-muted, #8c959f)" },

  // lists
  ".cm-zim-bullet": { display: "inline-block", width: "1.3em", color: "var(--zim-muted, #57606a)", textAlign: "left" },
  ".cm-zim-checkbox": {
    display: "inline-block",
    width: "1.5em",
    fontSize: "1.1em",
    lineHeight: "1",
    cursor: "pointer",
    verticalAlign: "-0.08em",
    userSelect: "none",
    textDecoration: "none",
  },
  ".cm-zim-checkbox-done": { color: "var(--zim-done, #1a7f37)" },
  ".cm-zim-checkbox-dropped": { color: "var(--zim-muted, #8c959f)" },
  ".cm-zim-checkbox-moved, .cm-zim-checkbox-moved-back": { color: "var(--zim-link, #0b57d0)" },
  ".cm-zim-item-done": { color: "var(--zim-muted, #6e7781)", textDecoration: "line-through", textDecorationColor: "var(--zim-border, #c8cdd2)" },
  ".cm-zim-item-dropped": { color: "var(--zim-muted, #8c959f)", textDecoration: "line-through" },
  ".cm-zim-list-number": { fontVariantNumeric: "tabular-nums" },

  // blocks
  ".cm-zim-indented": { borderLeft: "2px solid var(--zim-border, #d0d7de)" },
  ".cm-zim-header": {
    fontFamily: "var(--zim-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: ".78em",
    lineHeight: "1.5",
    color: "var(--zim-muted, #6e7781)",
  },
  ".cm-zim-header-key": { fontWeight: "600" },
  ".cm-zim-code, .cm-zim-opaque": {
    fontFamily: "var(--zim-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
    fontSize: ".92em",
    backgroundColor: "var(--zim-code-bg, #f0f1f3)",
    paddingLeft: ".75rem !important",
    paddingRight: ".75rem !important",
  },
  ".cm-zim-code-first": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px", marginTop: ".4em" },
  ".cm-zim-code-last": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px", marginBottom: ".4em" },
  ".cm-zim-code-open": { boxShadow: "inset 3px 0 0 var(--zim-warn, #bf8700)" },
  ".cm-zim-opaque": { color: "var(--zim-muted, #57606a)", boxShadow: "inset 3px 0 0 var(--zim-border, #d0d7de)" },
  ".cm-zim-rule": {
    display: "inline-block",
    width: "100%",
    borderTop: "2px solid var(--zim-border, #d0d7de)",
    verticalAlign: "middle",
  },
  // a small picture frame in front of an image's label
  ".cm-zim-chip-image::before": {
    content: '""',
    display: "inline-block",
    width: ".85em",
    height: ".62em",
    border: "1.5px solid currentColor",
    borderRadius: "2px",
    marginRight: ".4em",
    verticalAlign: "-0.04em",
    background: "linear-gradient(to top right, transparent 55%, currentColor 56%, currentColor 70%, transparent 71%)",
  },
  ".cm-zim-chip": {
    backgroundColor: "var(--zim-code-bg, #f0f1f3)",
    border: "1px solid var(--zim-border, #d0d7de)",
    borderRadius: "6px",
    padding: "0 .4em",
    fontSize: ".9em",
    color: "var(--zim-muted, #57606a)",
  },
});
