//! Inline markup: parsing and rendering of text that appears inside headings,
//! paragraphs and list items (§3 of the spec).
//!
//! The parser is total and lossless: every input string produces a `Vec<Inline>`
//! whose rendering reproduces the input exactly, byte for byte. Unmatched or
//! malformed markers (per spec §3.1) simply fall back to literal [`Inline::Text`].

/// One inline span of parsed text.
///
/// Every variant carries exactly the data needed to reconstruct its original
/// source text; [`render_inline`] is the exact inverse of [`parse_inline`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inline {
    /// Literal text with no recognized markup.
    Text(String),
    /// `**bold**`
    Bold(Vec<Inline>),
    /// `//italic//`
    Italic(Vec<Inline>),
    /// `__underline__`
    Underline(Vec<Inline>),
    /// `~~strikethrough~~`
    Strike(Vec<Inline>),
    /// `''verbatim''` — contents are raw text, never further inline-parsed
    /// (the one exception to "all markup combines freely", per spec §3.2).
    Verbatim(String),
    /// `^{superscript}`
    Superscript(Vec<Inline>),
    /// `_{subscript}`
    Subscript(Vec<Inline>),
    /// `[[target]]` or `[[target|display]]` — see [`Link`].
    Link(Link),
    /// `@tagname` (not recognized inside headings; see spec §3.4).
    Tag(String),
    /// `{{path?query|alt}}` — see [`Image`].
    Image(Image),
    /// `{{id: name}}` — an anchor definition. Stores the raw text between
    /// `{{id:` and `}}` verbatim (so exact spacing round-trips).
    Anchor(String),
    /// A bare URL or `mailto:` URI, autolinked without brackets (spec §3.3).
    /// Stores the exact matched text.
    AutoUrl(String),
    /// A bare email address, autolinked without brackets (spec §3.3).
    /// Stores the exact matched text.
    AutoEmail(String),
}

/// A `[[...]]` link (spec §3.3).
///
/// `target` and `display` are stored as raw, un-decoded strings: this crate
/// does no link resolution (no filesystem/page-graph knowledge), so forms
/// like `:foo`, `+foo`, `foo#anchor`, `#anchor`, and interwiki `wp?Test` are
/// all just opaque target text, kept exactly as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Raw text between `[[` and the first `|` (or `]]` if there is no `|`).
    pub target: String,
    /// Raw text between `|` and `]]`, if the link had a display part.
    pub display: Option<String>,
}

/// A `{{path?query|alt}}` image/embed (spec §3.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    /// Raw path text (before any `?query` or `|alt`).
    pub path: String,
    /// Ordered, opaque query parameters (after `?`, `&`-separated).
    /// `None` value means the token had no `=` (a bare flag token).
    /// Stored raw/un-decoded, including any percent-encoding.
    pub query: Vec<(String, Option<String>)>,
    /// Raw alt/label text after a trailing `|`, if present.
    pub alt: Option<String>,
}

const URL_SCHEMES: &[&str] = &["https://", "http://", "file://", "ftp://", "mailto:"];

fn is_local_part_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._%+-".contains(c)
}

/// Parse inline markup within one block's text (a heading, paragraph, or
/// list-item body). `allow_tags` is `false` for heading text (spec §3.4:
/// tags are a known exception, not recognized inside headings).
pub fn parse_inline(s: &str, allow_tags: bool) -> Vec<Inline> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut i = 0usize;
    let len = s.len();
    while i < len {
        if let Some((consumed, node)) = try_match_markup(s, i, allow_tags) {
            if !buf.is_empty() {
                out.push(Inline::Text(std::mem::take(&mut buf)));
            }
            out.push(node);
            i += consumed;
            continue;
        }
        let ch = s[i..].chars().next().expect("i < len implies a char is present");
        buf.push(ch);
        i += ch.len_utf8();
    }
    if !buf.is_empty() {
        out.push(Inline::Text(buf));
    }
    out
}

/// Render a parsed span list back to its exact original text.
pub fn render_inline(spans: &[Inline]) -> String {
    let mut out = String::new();
    for sp in spans {
        render_one(sp, &mut out);
    }
    out
}

fn render_one(sp: &Inline, out: &mut String) {
    match sp {
        Inline::Text(t) => out.push_str(t),
        Inline::Bold(c) => wrap(out, "**", c, "**"),
        Inline::Italic(c) => wrap(out, "//", c, "//"),
        Inline::Underline(c) => wrap(out, "__", c, "__"),
        Inline::Strike(c) => wrap(out, "~~", c, "~~"),
        Inline::Verbatim(t) => {
            out.push_str("''");
            out.push_str(t);
            out.push_str("''");
        }
        Inline::Superscript(c) => {
            out.push_str("^{");
            out.push_str(&render_inline(c));
            out.push('}');
        }
        Inline::Subscript(c) => {
            out.push_str("_{");
            out.push_str(&render_inline(c));
            out.push('}');
        }
        Inline::Link(l) => {
            out.push_str("[[");
            out.push_str(&l.target);
            if let Some(d) = &l.display {
                out.push('|');
                out.push_str(d);
            }
            out.push_str("]]");
        }
        Inline::Tag(name) => {
            out.push('@');
            out.push_str(name);
        }
        Inline::Image(im) => {
            out.push_str("{{");
            out.push_str(&im.path);
            if !im.query.is_empty() {
                out.push('?');
                for (idx, (k, v)) in im.query.iter().enumerate() {
                    if idx > 0 {
                        out.push('&');
                    }
                    out.push_str(k);
                    if let Some(v) = v {
                        out.push('=');
                        out.push_str(v);
                    }
                }
            }
            if let Some(alt) = &im.alt {
                out.push('|');
                out.push_str(alt);
            }
            out.push_str("}}");
        }
        Inline::Anchor(raw) => {
            out.push_str("{{id:");
            out.push_str(raw);
            out.push_str("}}");
        }
        Inline::AutoUrl(raw) => out.push_str(raw),
        Inline::AutoEmail(raw) => out.push_str(raw),
    }
}

fn wrap(out: &mut String, open: &str, content: &[Inline], close: &str) {
    out.push_str(open);
    out.push_str(&render_inline(content));
    out.push_str(close);
}

/// Try to match one inline marker starting exactly at byte offset `i` in `s`.
/// Returns `(bytes_consumed, node)` on success. On failure, returns `None` and
/// the caller falls back to consuming one plain-text character — this is what
/// makes unmatched markers degrade to literal text (spec §3.1).
fn try_match_markup(s: &str, i: usize, allow_tags: bool) -> Option<(usize, Inline)> {
    let rest = &s[i..];

    if let Some(link_rest) = rest.strip_prefix("[[") {
        if let Some(end) = link_rest.find("]]") {
            let content = &link_rest[..end];
            let (target, display) = match content.find('|') {
                Some(p) => (content[..p].to_string(), Some(content[p + 1..].to_string())),
                None => (content.to_string(), None),
            };
            let consumed = 2 + end + 2;
            return Some((consumed, Inline::Link(Link { target, display })));
        }
        return None;
    }

    if let Some(after) = rest.strip_prefix("{{") {
        if let Some(anchor_rest) = after.strip_prefix("id:") {
            if let Some(end) = anchor_rest.find("}}") {
                let raw = anchor_rest[..end].to_string();
                let consumed = 2 + 3 + end + 2;
                return Some((consumed, Inline::Anchor(raw)));
            }
            return None;
        }
        if let Some(end) = after.find("}}") {
            let content = &after[..end];
            let (before_alt, alt) = match content.rfind('|') {
                Some(p) => (&content[..p], Some(content[p + 1..].to_string())),
                None => (content, None),
            };
            let (path, query) = match before_alt.find('?') {
                Some(p) => (before_alt[..p].to_string(), parse_query(&before_alt[p + 1..])),
                None => (before_alt.to_string(), Vec::new()),
            };
            let consumed = 2 + end + 2;
            return Some((consumed, Inline::Image(Image { path, query, alt })));
        }
        return None;
    }

    if let Some(verbatim_rest) = rest.strip_prefix("''") {
        if let Some(end) = verbatim_rest.find("''") {
            let content = verbatim_rest[..end].to_string();
            let consumed = 2 + end + 2;
            return Some((consumed, Inline::Verbatim(content)));
        }
        return None;
    }

    if rest.starts_with("**") {
        return match_paired(rest, "**", "**").map(|(consumed, content)| {
            (consumed, Inline::Bold(parse_inline(content, allow_tags)))
        });
    }

    if rest.starts_with("__") {
        return match_paired(rest, "__", "__").map(|(consumed, content)| {
            (consumed, Inline::Underline(parse_inline(content, allow_tags)))
        });
    }

    if rest.starts_with("~~") {
        return match_paired(rest, "~~", "~~").map(|(consumed, content)| {
            (consumed, Inline::Strike(parse_inline(content, allow_tags)))
        });
    }

    if rest.starts_with("^{") {
        return match_paired(rest, "^{", "}").map(|(consumed, content)| {
            (consumed, Inline::Superscript(parse_inline(content, allow_tags)))
        });
    }

    if rest.starts_with("_{") {
        return match_paired(rest, "_{", "}").map(|(consumed, content)| {
            (consumed, Inline::Subscript(parse_inline(content, allow_tags)))
        });
    }

    if rest.starts_with("//") {
        return match_paired(rest, "//", "//").map(|(consumed, content)| {
            (consumed, Inline::Italic(parse_inline(content, allow_tags)))
        });
    }

    if allow_tags && rest.starts_with('@') {
        let prev_ok = i == 0
            || !s[..i]
                .chars()
                .next_back()
                .map(|c| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(false);
        if prev_ok {
            let mut j = 1usize;
            while j < rest.len() {
                let c = rest[j..].chars().next().unwrap();
                if c.is_ascii_alphanumeric() || c == '_' {
                    j += c.len_utf8();
                } else {
                    break;
                }
            }
            if j > 1 {
                return Some((j, Inline::Tag(rest[1..j].to_string())));
            }
        }
    }

    // Note: this check is intentionally *not* gated on the preceding
    // character. It must fire the moment `rest` starts with a scheme, at
    // every scan position, with no exception — otherwise a scheme whose
    // prefix check is skipped (e.g. immediately after an alphanumeric with
    // no separating space) would fall back to one-plain-char-at-a-time
    // consumption, which would walk the scanner right into the bare `//` of
    // `https://` / `ftp://` and mis-fire the italic-marker check there
    // instead. Firing unconditionally at the scheme's own start keeps that
    // `//` from ever being visited as a fresh scan position.
    for scheme in URL_SCHEMES {
        if rest.starts_with(scheme) {
            let mut j = scheme.len();
            while j < rest.len() {
                let c = rest[j..].chars().next().unwrap();
                if c.is_whitespace() {
                    break;
                }
                j += c.len_utf8();
            }
            return Some((j, Inline::AutoUrl(rest[..j].to_string())));
        }
    }

    let prev_local = i > 0
        && s[..i]
            .chars()
            .next_back()
            .map(is_local_part_char)
            .unwrap_or(false);
    if !prev_local {
        if let Some(end) = match_email(s, i) {
            return Some((end - i, Inline::AutoEmail(s[i..end].to_string())));
        }
    }

    None
}

/// Match `open` at the start of `rest`, then find the next `close` after it.
/// Returns `(total_bytes_consumed, content_between_markers)`.
fn match_paired<'a>(rest: &'a str, open: &str, close: &str) -> Option<(usize, &'a str)> {
    debug_assert!(rest.starts_with(open));
    let after_open = &rest[open.len()..];
    let end = find_close(after_open, close)?;
    let content = &after_open[..end];
    Some((open.len() + end + close.len(), content))
}

/// Find the next occurrence of `close` in `haystack`, without letting the
/// search be "stolen" by a higher-priority construct's own delimiters that
/// happen to contain the same characters (spec §3.2 / §3.3).
///
/// Two constructs get this protection:
/// - An inline-verbatim span (`''...''`): per spec §3.2 verbatim is opaque,
///   so a `close` sequence hiding inside its content (e.g. a literal `**`
///   inside `''a ** b''`) must never be mistaken for an enclosing marker's
///   own closing delimiter. The whole verbatim span is skipped as one unit.
///   An unterminated `''` isn't actually verbatim (spec §3.1: falls back to
///   literal), so its own two quote characters are *not* skipped in that
///   case -- the search just continues past them one character at a time.
/// - A recognized URL scheme prefix (spec §3.3, e.g. `https://`): its own
///   `://`-embedded slashes must never be mistaken for italic's `//`
///   closing delimiter. Only the scheme token itself is skipped (not the
///   whole URL), so a legitimate `close` occurring later in the same line
///   (e.g. italic's true closing `//`, right after the URL) is still found.
fn find_close(haystack: &str, close: &str) -> Option<usize> {
    let mut i = 0usize;
    let len = haystack.len();
    while i < len {
        let rest = &haystack[i..];
        if rest.starts_with(close) {
            return Some(i);
        }
        if let Some(after_open) = rest.strip_prefix("''") {
            if let Some(end) = after_open.find("''") {
                i += 2 + end + 2;
                continue;
            }
        }
        if let Some(scheme) = URL_SCHEMES.iter().find(|s| rest.starts_with(**s)) {
            i += scheme.len();
            continue;
        }
        let ch = rest.chars().next().expect("i < len implies a char is present");
        i += ch.len_utf8();
    }
    None
}

fn parse_query(qs: &str) -> Vec<(String, Option<String>)> {
    if qs.is_empty() {
        return Vec::new();
    }
    qs.split('&')
        .map(|tok| match tok.find('=') {
            Some(p) => (tok[..p].to_string(), Some(tok[p + 1..].to_string())),
            None => (tok.to_string(), None),
        })
        .collect()
}

/// Attempt to match `local@domain.tld` starting exactly at byte offset `i`.
/// Returns the end offset (exclusive) on success.
fn match_email(s: &str, i: usize) -> Option<usize> {
    let len = s.len();
    let mut j = i;
    let local_start = j;
    while j < len {
        let c = s[j..].chars().next().unwrap();
        if is_local_part_char(c) {
            j += c.len_utf8();
        } else {
            break;
        }
    }
    if j == local_start {
        return None;
    }
    if !s[j..].starts_with('@') {
        return None;
    }
    j += 1;

    let mut labels: Vec<(usize, usize)> = Vec::new();
    loop {
        let seg_start = j;
        while j < len {
            let c = s[j..].chars().next().unwrap();
            if c.is_ascii_alphanumeric() || c == '-' {
                j += c.len_utf8();
            } else {
                break;
            }
        }
        if j == seg_start {
            break;
        }
        labels.push((seg_start, j));
        if s[j..].starts_with('.') {
            j += 1;
            continue;
        }
        break;
    }
    if labels.len() < 2 {
        return None;
    }
    let (tld_s, tld_e) = *labels.last().unwrap();
    let tld = &s[tld_s..tld_e];
    if tld.len() < 2 || !tld.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(tld_e)
}
