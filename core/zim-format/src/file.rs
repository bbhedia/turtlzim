//! A page file's bytes, and the text inside them.
//!
//! The parser and the editor work on *text*. A file also has a byte-order mark or not, and ends
//! its lines with `\n` or `\r\n`; those are properties of the file, not of the page, and leaving
//! them in the text makes the page unreadable to the parser: a mark in front of `Content-Type:`
//! hides the header block, and a `\r` before every newline stops a heading's closing `======`
//! from being at the end of its line. [`PageFile`] splits them off and puts them back, so that
//!
//! ```
//! # use zim_format::PageFile;
//! let bytes = b"\xEF\xBB\xBFContent-Type: text/x-zim-wiki\r\n\r\n====== Title ======\r\n";
//! let file = PageFile::decode(bytes).unwrap();
//! assert!(file.bom);
//! assert_eq!(file.text, "Content-Type: text/x-zim-wiki\n\n====== Title ======\n");
//! assert_eq!(file.encode(), bytes); // the file is rewritten exactly as it was read
//! ```
//!
//! `PageFile::decode(bytes)?.encode() == bytes` for every valid UTF-8 `bytes`, including files
//! that mix line endings, contain a lone `\r`, or consist of nothing but a mark.
//!
//! Zim writes `\n`, no mark. Files that differ are kept as they are, not "fixed": rewriting a
//! user's file in another dialect is a change they did not ask for.

use std::str::Utf8Error;

const BOM: &str = "\u{feff}";

/// How the lines of a file end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LineEnding {
    /// `\n`, or no line ending at all (a lone `\r` is then ordinary text of the page).
    Lf,
    /// `\r\n` on every line. The page text has `\n`; [`PageFile::encode`] restores the `\r`.
    Crlf,
    /// Both kinds, or `\r\n` next to a lone `\r`. The text is the file's, `\r` included,
    /// since there is no single style to restore.
    Mixed,
}

/// The parts of a page file: the file's own properties and the page text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageFile {
    /// The file begins with a UTF-8 byte-order mark (`EF BB BF`). It is not in `text`.
    pub bom: bool,
    pub line_ending: LineEnding,
    /// The page, ready for [`crate::parse`]: no mark, and `\n` line endings if the file used
    /// `\r\n` throughout.
    pub text: String,
}

impl PageFile {
    /// Split `bytes` into the file's properties and its text. Fails if `bytes` are not UTF-8:
    /// such a file can't be a Zim page (they are UTF-8 by definition) and must be refused or
    /// repaired in front of the user, never converted and written back.
    pub fn decode(bytes: &[u8]) -> Result<PageFile, Utf8Error> {
        let all = std::str::from_utf8(bytes)?;
        let (bom, body) = match all.strip_prefix(BOM) {
            Some(rest) => (true, rest),
            None => (false, all),
        };
        let line_ending = classify(body);
        let text = if line_ending == LineEnding::Crlf {
            body.replace("\r\n", "\n")
        } else {
            body.to_string()
        };
        Ok(PageFile {
            bom,
            line_ending,
            text,
        })
    }

    /// A page that has no file yet: no mark, `\n` endings.
    pub fn new(text: impl Into<String>) -> PageFile {
        PageFile {
            bom: false,
            line_ending: LineEnding::Lf,
            text: text.into(),
        }
    }

    /// The bytes of the file.
    ///
    /// For a [`LineEnding::Crlf`] file every `\n` of the text becomes `\r\n`, so edited text must
    /// not contain a `\r` of its own before a `\n` (an editor turns pasted line endings into
    /// `\n`); the inverse of [`PageFile::decode`] is exact for what `decode` produced.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.text.len() + 8);
        if self.bom {
            out.extend_from_slice(BOM.as_bytes());
        }
        if self.line_ending == LineEnding::Crlf {
            out.extend_from_slice(self.text.replace('\n', "\r\n").as_bytes());
        } else {
            out.extend_from_slice(self.text.as_bytes());
        }
        out
    }
}

/// `Crlf` only when every `\n` follows a `\r` and every `\r` precedes a `\n`; `Mixed` when
/// `\r\n` occurs next to a bare `\n` or a bare `\r`; otherwise `Lf`.
fn classify(text: &str) -> LineEnding {
    let bytes = text.as_bytes();
    let (mut crlf, mut lone_lf, mut lone_cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 2;
                continue;
            }
            b'\r' => lone_cr += 1,
            b'\n' => lone_lf += 1,
            _ => {}
        }
        i += 1;
    }
    match (crlf, lone_lf + lone_cr) {
        (0, _) => LineEnding::Lf,
        (_, 0) => LineEnding::Crlf,
        _ => LineEnding::Mixed,
    }
}
