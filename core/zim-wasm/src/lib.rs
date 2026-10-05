//! WebAssembly bindings for `zim-format`: what the web editor needs from the Zim parser.
//!
//! The editor's document is the Zim text itself (`docs/zim-editor-plan.md`); this crate only
//! *describes* that text. [`highlight`] returns the syntax spans of a page, and [`span_codes`]
//! returns the numeric codes those spans use, so the TypeScript side can verify its own constants
//! against the wasm it was built with instead of trusting that the two were built together.
//!
//! [`decode_page`] and [`encode_page`] are the file layer (`zim_format::PageFile`): a page file's
//! bytes split into byte-order mark, line-ending style and the text the parser and the editor work
//! on, and back, exactly. Every shell (browser, desktop, mobile) opens and saves through them, so
//! they all agree about what a Zim file is.
//!
//! Build it into the web package with `npm run wasm` in `web/`.

use wasm_bindgen::prelude::*;
use zim_format::highlight::{list_marker, opaque, VERBATIM_UNTERMINATED};
use zim_format::{LineEnding, PageFile, SpanKind};

/// The syntax spans of `text`, flat: four `u32` per span, `[start, end, kind, detail]`, with
/// `start` and `end` counted in UTF-16 units (the unit of JavaScript strings and CodeMirror
/// positions). Pre-order, properly nested; see `zim_format::highlight` for the full guarantees and
/// for what `kind` and `detail` mean.
#[wasm_bindgen]
pub fn highlight(text: &str) -> Vec<u32> {
    let bytes = zim_format::highlight(text);
    let spans = zim_format::to_utf16(text, &bytes);
    let mut flat = Vec::with_capacity(spans.len() * 4);
    for s in &spans {
        flat.extend_from_slice(&[
            s.start as u32,
            s.end as u32,
            u32::from(s.kind.code()),
            s.detail,
        ]);
    }
    flat
}

/// The codes the spans use, as JSON:
/// `{"kinds": {"Heading": 3, ...}, "listMarker": {...}, "opaque": {...}, "verbatimUnterminated": n}`.
#[wasm_bindgen(js_name = spanCodes)]
pub fn span_codes() -> String {
    fn object(entries: &[(&str, u32)]) -> String {
        let body: Vec<String> = entries
            .iter()
            .map(|(name, code)| format!("\"{name}\":{code}"))
            .collect();
        format!("{{{}}}", body.join(","))
    }
    let kinds: Vec<(&str, u32)> = SpanKind::ALL
        .iter()
        .map(|k| (k.name(), u32::from(k.code())))
        .collect();
    let markers = [
        ("BULLET", list_marker::BULLET),
        ("NUMBER", list_marker::NUMBER),
        ("LOWER_ALPHA", list_marker::LOWER_ALPHA),
        ("UPPER_ALPHA", list_marker::UPPER_ALPHA),
        ("UNCHECKED", list_marker::UNCHECKED),
        ("CHECKED", list_marker::CHECKED),
        ("XCHECKED", list_marker::XCHECKED),
        ("MIGRATED", list_marker::MIGRATED),
        ("TRANSMIGRATED", list_marker::TRANSMIGRATED),
    ];
    let opaques = [("TABLE", opaque::TABLE), ("OBJECT", opaque::OBJECT)];
    format!(
        "{{\"kinds\":{},\"listMarker\":{},\"opaque\":{},\"verbatimUnterminated\":{}}}",
        object(&kinds),
        object(&markers),
        object(&opaques),
        VERBATIM_UNTERMINATED
    )
}

/// A page file taken apart by [`decode_page`].
#[wasm_bindgen]
pub struct DecodedPage {
    file: PageFile,
}

#[wasm_bindgen]
impl DecodedPage {
    /// The page, ready for the editor and the parser: no byte-order mark, `\n` line endings if the
    /// file used `\r\n` throughout.
    #[wasm_bindgen(getter)]
    pub fn text(&self) -> String {
        self.file.text.clone()
    }

    /// The file started with a UTF-8 byte-order mark (which `text` does not contain).
    #[wasm_bindgen(getter)]
    pub fn bom(&self) -> bool {
        self.file.bom
    }

    /// `"lf"`, `"crlf"` or `"mixed"`; pass it back to [`encode_page`] when saving.
    #[wasm_bindgen(getter, js_name = lineEnding)]
    pub fn line_ending(&self) -> String {
        match self.file.line_ending {
            LineEnding::Lf => "lf",
            LineEnding::Crlf => "crlf",
            LineEnding::Mixed => "mixed",
        }
        .to_string()
    }
}

/// Take a page file's bytes apart. Throws if they are not UTF-8: such a file can't be a Zim page,
/// and must be refused (or repaired in front of the user), never converted and written back.
#[wasm_bindgen(js_name = decodePage)]
pub fn decode_page(bytes: &[u8]) -> Result<DecodedPage, JsError> {
    PageFile::decode(bytes)
        .map(|file| DecodedPage { file })
        .map_err(|e| {
            JsError::new(&format!(
                "not valid UTF-8 (the first bad byte is at offset {})",
                e.valid_up_to()
            ))
        })
}

/// The bytes of a page file: `text` with the byte-order mark and line-ending style the file had
/// when it was opened (`"lf"`, `"crlf"` or `"mixed"`, as [`DecodedPage`] reports them).
#[wasm_bindgen(js_name = encodePage)]
pub fn encode_page(text: &str, bom: bool, line_ending: &str) -> Result<Vec<u8>, JsError> {
    let line_ending = match line_ending {
        "lf" => LineEnding::Lf,
        "crlf" => LineEnding::Crlf,
        "mixed" => LineEnding::Mixed,
        other => {
            return Err(JsError::new(&format!(
                "unknown line ending {other:?}: expected \"lf\", \"crlf\" or \"mixed\""
            )))
        }
    };
    Ok(PageFile {
        bom,
        line_ending,
        text: text.to_string(),
    }
    .encode())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_spans_are_the_utf16_spans_four_words_each() {
        // 😀 is two UTF-16 units and four UTF-8 bytes, so byte and unit offsets differ after it.
        let text = "😀 **bold**";
        let flat = highlight(text);
        let spans = zim_format::to_utf16(text, &zim_format::highlight(text));
        assert_eq!(flat.len(), spans.len() * 4);
        assert_eq!(&flat[0..4], &[3, 11, u32::from(SpanKind::Bold.code()), 0]);
        for (words, span) in flat.chunks(4).zip(&spans) {
            assert_eq!(
                words,
                [
                    span.start as u32,
                    span.end as u32,
                    u32::from(span.kind.code()),
                    span.detail
                ]
            );
        }
    }

    // `JsError` isn't `Debug`, so `.expect()` on these results doesn't compile: `.ok().expect()` it is.
    #[test]
    #[allow(clippy::ok_expect)]
    fn the_file_layer_round_trips_through_the_wasm_functions() {
        let bytes = b"\xEF\xBB\xBFContent-Type: text/x-zim-wiki\r\n\r\n====== T ======\r\n";
        let page = decode_page(bytes).ok().expect("valid UTF-8");
        assert!(page.bom());
        assert_eq!(page.line_ending(), "crlf");
        assert_eq!(
            page.text(),
            "Content-Type: text/x-zim-wiki\n\n====== T ======\n"
        );
        let back = encode_page(&page.text(), page.bom(), &page.line_ending())
            .ok()
            .expect("known line ending");
        assert_eq!(back, bytes);
    }

    #[test]
    fn span_codes_lists_every_kind_once() {
        let json = span_codes();
        for kind in SpanKind::ALL {
            let entry = format!("\"{}\":{}", kind.name(), kind.code());
            assert_eq!(json.matches(&entry).count(), 1, "{entry} in {json}");
        }
        assert!(json.contains("\"verbatimUnterminated\":65536"));
    }
}
