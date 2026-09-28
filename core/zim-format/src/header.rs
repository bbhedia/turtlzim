//! RFC822-style page header block (spec §1.1).

/// One `Key: value` header field, with any continuation lines.
///
/// To guarantee byte-exact round-trip regardless of the exact whitespace
/// convention used after the colon, `value_first_line` stores everything
/// after the first `:` on the header's own line verbatim (normally this
/// starts with a single space, e.g. `" some value"`), and each continuation
/// line is stored verbatim including its own leading whitespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderField {
    /// The header key, e.g. `"Content-Type"`.
    pub key: String,
    /// Raw text after the first `:` on the header's own line.
    pub value_first_line: String,
    /// Subsequent raw continuation lines (each starts with whitespace),
    /// stored verbatim, in order.
    pub continuations: Vec<String>,
}

impl HeaderField {
    fn render_lines(&self) -> Vec<String> {
        let mut lines = Vec::with_capacity(1 + self.continuations.len());
        lines.push(format!("{}:{}", self.key, self.value_first_line));
        lines.extend(self.continuations.iter().cloned());
        lines
    }
}

fn is_header_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Try to find a valid `Key:` prefix at the start of `line` (a line that does
/// not itself start with whitespace — continuation lines are handled by the
/// caller). Returns the key and the raw remainder after the colon.
fn split_header_line(line: &str) -> Option<(&str, &str)> {
    if line.is_empty() {
        return None;
    }
    let first = line.chars().next().unwrap();
    if first.is_whitespace() {
        return None;
    }
    let colon = line.find(':')?;
    let key = &line[..colon];
    if key.is_empty() || !key.chars().all(is_header_key_char) {
        return None;
    }
    let after = &line[colon + 1..];
    // Spec §1.1's own form is `Key: value` -- every worked example has a
    // space right after the colon. Requiring that here (or an empty value)
    // is what keeps an ordinary line that merely *contains* a colon (e.g. a
    // paragraph opening with a bare "https://..." URL, whose text before the
    // first ':' happens to be a bare word like "https") from being mistaken
    // for a header field: a URL's colon is never followed by a space.
    match after.chars().next() {
        None => Some((key, after)),
        Some(c) if c.is_whitespace() => Some((key, after)),
        _ => None,
    }
}

/// Try to parse a leading header block out of `lines`.
///
/// Returns `Some((fields, body_start))` if a valid header block was found
/// (at least one header line, cleanly terminated by a blank line);
/// `body_start` is the index of the first body line (just past that blank
/// separator). Returns `None` if no header block is present — the whole
/// input is then body text starting at line 0.
pub fn parse_headers(lines: &[&str]) -> Option<(Vec<HeaderField>, usize)> {
    let mut fields: Vec<HeaderField> = Vec::new();
    let mut idx = 0usize;
    loop {
        if idx >= lines.len() {
            // Ran off the end without a blank separator: not a valid header
            // block (per spec, the blank line is required whenever a header
            // block is present). Fall back to "no header block".
            return None;
        }
        let line = lines[idx];
        if line.is_empty() {
            if fields.is_empty() {
                return None;
            }
            return Some((fields, idx + 1));
        }
        let first = line.chars().next().unwrap();
        if first.is_whitespace() {
            let f = fields.last_mut()?;
            f.continuations.push(line.to_string());
            idx += 1;
            continue;
        }
        match split_header_line(line) {
            Some((key, value_first_line)) => {
                fields.push(HeaderField {
                    key: key.to_string(),
                    value_first_line: value_first_line.to_string(),
                    continuations: Vec::new(),
                });
                idx += 1;
            }
            None => return None,
        }
    }
}

/// Render a header block's fields to their raw lines (not including the
/// mandatory blank separator line that follows — the caller adds that).
pub fn render_headers(fields: &[HeaderField]) -> Vec<String> {
    fields.iter().flat_map(HeaderField::render_lines).collect()
}
