//! The file layer: a page file's bytes split into {byte-order mark, line ending, text} and put
//! back. The promise is `decode(bytes).encode() == bytes` for every valid UTF-8 file; the point of
//! the split is that the text is what the parser can read, whatever dialect the file is in.

mod common;
use common::{span_problem, Rng};
use zim_format::{LineEnding, PageFile};

fn decode(bytes: &[u8]) -> PageFile {
    PageFile::decode(bytes).expect("valid UTF-8")
}

#[test]
fn an_ordinary_unix_file_is_its_own_text() {
    let file = decode(b"====== T ======\ntext\n");
    assert_eq!(
        file,
        PageFile {
            bom: false,
            line_ending: LineEnding::Lf,
            text: "====== T ======\ntext\n".into()
        }
    );
    assert_eq!(file, PageFile::new("====== T ======\ntext\n"));
}

#[test]
fn a_byte_order_mark_is_split_off_and_comes_back() {
    let file = decode(b"\xEF\xBB\xBFfoobar\n"); // Zim's own tests/data/byteordermark.txt
    assert!(file.bom);
    assert_eq!(file.text, "foobar\n");
    assert_eq!(file.encode(), b"\xEF\xBB\xBFfoobar\n");
    // Only a mark at the very start is the file's; one anywhere else is a character of the page.
    let later = decode("a\u{feff}b".as_bytes());
    assert!(!later.bom);
    assert_eq!(later.text, "a\u{feff}b");
    // Two marks: the first is the file's, the second the page's.
    let two = decode("\u{feff}\u{feff}x".as_bytes());
    assert!(two.bom);
    assert_eq!(two.text, "\u{feff}x");
}

#[test]
fn crlf_throughout_becomes_lf_in_the_text_and_is_restored() {
    for (bytes, text) in [
        (&b"a\r\nb\r\n"[..], "a\nb\n"),
        (b"a\r\nb", "a\nb"), // no final line ending
        (b"\r\n", "\n"),
        (b"\r\n\r\n\r\n", "\n\n\n"),
    ] {
        let file = decode(bytes);
        assert_eq!(file.line_ending, LineEnding::Crlf, "{bytes:?}");
        assert_eq!(file.text, text, "{bytes:?}");
        assert_eq!(file.encode(), bytes, "{bytes:?}");
    }
}

#[test]
fn files_without_one_consistent_style_are_kept_exactly() {
    let cases: [(&[u8], LineEnding); 6] = [
        (b"a\r\nb\n", LineEnding::Mixed), // CRLF and LF
        (b"a\nb\r\n", LineEnding::Mixed),
        (b"a\r\nb\r", LineEnding::Mixed), // CRLF and a lone CR
        (b"a\r\r\nb", LineEnding::Mixed), // a CR before a CRLF
        (b"a\rb\rc", LineEnding::Lf),     // only lone CRs: ordinary text
        (b"\r", LineEnding::Lf),
    ];
    for (bytes, expected) in cases {
        let file = decode(bytes);
        assert_eq!(file.line_ending, expected, "{bytes:?}");
        assert_eq!(
            file.text.as_bytes(),
            bytes,
            "the text is the file's, untouched: {bytes:?}"
        );
        assert_eq!(file.encode(), bytes, "{bytes:?}");
    }
}

#[test]
fn the_empty_file_and_a_file_of_only_a_mark() {
    assert_eq!(decode(b""), PageFile::new(""));
    let mark = decode(b"\xEF\xBB\xBF");
    assert!(mark.bom);
    assert_eq!(mark.text, "");
    assert_eq!(mark.encode(), b"\xEF\xBB\xBF");
}

#[test]
fn bytes_that_are_not_utf8_are_refused() {
    // Zim's own tests/data/non-utf8.txt starts like this; a truncated character is the other kind.
    for bytes in [&b"\xD0\xD1\xE6"[..], b"abc\xE2\x82", b"\xFF", b"ok\xC3"] {
        assert!(PageFile::decode(bytes).is_err(), "{bytes:?}");
    }
}

#[test]
fn stripping_the_mark_and_the_carriage_returns_is_what_lets_the_parser_read_the_page() {
    let bytes =
        "\u{feff}Content-Type: text/x-zim-wiki\r\n\r\n====== Windows page ======\r\n[ ] task\r\n";
    let file = decode(bytes.as_bytes());

    // Parsed as the file's raw text, it is mostly unreadable: no header, no heading.
    let raw = zim_format::parse(bytes);
    assert!(raw.headers.is_none());
    assert!(!raw
        .body
        .blocks
        .iter()
        .any(|b| matches!(b, zim_format::Block::Heading(_))));

    // Parsed as the page text, it is what it says.
    let page = zim_format::parse(&file.text);
    assert_eq!(
        page.headers.as_ref().map(|h| h[0].key.as_str()),
        Some("Content-Type")
    );
    assert!(page
        .body
        .blocks
        .iter()
        .any(|b| matches!(b, zim_format::Block::Heading(h) if h.level == 1)));
    assert_eq!(page.serialize(), file.text);
    assert_eq!(span_problem(&file.text), None);
    assert_eq!(file.encode(), bytes.as_bytes());
}

/// Arbitrary files: pieces that are line endings, marks and ordinary and multi-byte text, in any
/// order, so every combination of the dialects occurs.
#[test]
fn every_valid_utf8_file_is_rewritten_exactly() {
    const PIECES: &[&str] = &[
        "\r\n",
        "\r\n",
        "\n",
        "\n",
        "\r",
        "\u{feff}",
        "a",
        "word ",
        "\t",
        "é",
        "日本",
        "😀",
        "====== T ======",
        "* x",
        "[ ] t",
        "**b**",
        "",
    ];
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let mut seen = std::collections::HashMap::new();
    for case in 0..60_000 {
        let n = rng.below(14);
        let text: String = (0..n).map(|_| PIECES[rng.below(PIECES.len())]).collect();
        let file = decode(text.as_bytes());
        assert_eq!(file.encode(), text.as_bytes(), "case {case}: {text:?}");
        // The text is always something the parser reads losslessly and the spans describe.
        assert_eq!(
            zim_format::parse(&file.text).serialize(),
            file.text,
            "case {case}: {text:?}"
        );
        assert_eq!(span_problem(&file.text), None, "case {case}: {text:?}");
        // A CRLF file's text has no carriage return before a line break left to restore.
        if file.line_ending == LineEnding::Crlf {
            assert!(!file.text.contains('\r'), "case {case}: {text:?}");
        }
        *seen.entry((file.bom, file.line_ending)).or_insert(0usize) += 1;
    }
    // The generator really did reach every kind of file.
    for bom in [false, true] {
        for ending in [LineEnding::Lf, LineEnding::Crlf, LineEnding::Mixed] {
            assert!(
                seen.get(&(bom, ending)).copied().unwrap_or(0) > 50,
                "{bom} {ending:?}: {seen:?}"
            );
        }
    }
}
