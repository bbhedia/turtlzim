// The numeric codes of `core/zim-format`'s syntax spans (src/highlight.rs). They are an interface
// to the wasm module: `checkCodes` compares these constants with what the wasm that was actually
// built reports, so a stale or mismatched build fails at load time, loudly, not as wrong
// formatting. Add new codes here and in Rust together; never renumber.

export const Kind = {
  Header: 1,
  HeaderKey: 2,
  Heading: 3,
  IndentedParagraph: 4,
  ListItem: 5,
  ListMarker: 6,
  VerbatimBlock: 7,
  HorizontalRule: 8,
  Opaque: 9,
  Marker: 10,
  Bold: 11,
  Italic: 12,
  Underline: 13,
  Strike: 14,
  InlineVerbatim: 15,
  Superscript: 16,
  Subscript: 17,
  Link: 18,
  LinkTarget: 19,
  LinkDisplay: 20,
  Tag: 21,
  Image: 22,
  Anchor: 23,
  AutoUrl: 24,
  AutoEmail: 25,
} as const;

export type KindName = keyof typeof Kind;

/** `detail` of a ListMarker span. */
export const ListMarker = {
  BULLET: 1,
  NUMBER: 2,
  LOWER_ALPHA: 3,
  UPPER_ALPHA: 4,
  UNCHECKED: 10,
  CHECKED: 11,
  XCHECKED: 12,
  MIGRATED: 13,
  TRANSMIGRATED: 14,
} as const;

/** `detail` of an Opaque span. */
export const Opaque = { TABLE: 1, OBJECT: 2 } as const;

/** Set in the `detail` of a VerbatimBlock that was never closed. */
export const VERBATIM_UNTERMINATED = 1 << 16;

interface Codes {
  kinds: Record<string, number>;
  listMarker: Record<string, number>;
  opaque: Record<string, number>;
  verbatimUnterminated: number;
}

function sameTable(what: string, ours: Record<string, number>, theirs: Record<string, number>): void {
  const names = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const name of names) {
    if (ours[name] !== theirs[name]) {
      throw new Error(
        `${what} ${name}: the TypeScript constants say ${ours[name]}, the wasm module says ${theirs[name]}. ` +
          "Rebuild the wasm (npm run wasm) or update src/kinds.ts.",
      );
    }
  }
}

/** Throw unless the constants above are exactly what the wasm module reports. */
export function checkCodes(wasm: Codes): void {
  sameTable("span kind", Kind, wasm.kinds);
  sameTable("list marker", ListMarker, wasm.listMarker);
  sameTable("opaque kind", Opaque, wasm.opaque);
  if (wasm.verbatimUnterminated !== VERBATIM_UNTERMINATED) {
    throw new Error(`VERBATIM_UNTERMINATED: ${VERBATIM_UNTERMINATED} here, ${wasm.verbatimUnterminated} in the wasm`);
  }
}
