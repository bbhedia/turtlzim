//! The little bit of JSON the bindings return. Written by hand: the shapes are few and small, and
//! `serde` would add tens of kilobytes to the wasm for nothing else.

/// A JSON value.
pub enum J {
    Null,
    Bool(bool),
    Num(usize),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(&'static str, J)>),
}

pub fn s(text: impl Into<String>) -> J {
    J::Str(text.into())
}

pub fn opt(text: Option<String>) -> J {
    text.map_or(J::Null, J::Str)
}

impl J {
    pub fn render(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(&n.to_string()),
            J::Str(text) => escape(text, out),
            J::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            J::Obj(fields) => {
                out.push('{');
                for (i, (key, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    escape(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn escape(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Other control characters, and the two line separators that older JavaScript
            // parsers treat as line breaks inside a string.
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_render_as_json() {
        let value = J::Obj(vec![
            ("name", s("Help:Links")),
            ("count", J::Num(3)),
            ("ok", J::Bool(true)),
            ("none", J::Null),
            ("list", J::Arr(vec![s("a"), J::Num(1), J::Arr(vec![])])),
            ("nested", J::Obj(vec![])),
        ]);
        assert_eq!(
            value.render(),
            r#"{"name":"Help:Links","count":3,"ok":true,"none":null,"list":["a",1,[]],"nested":{}}"#
        );
    }

    #[test]
    fn strings_are_escaped_so_that_any_text_survives() {
        let nasty = "quote\" backslash\\ newline\n tab\t cr\r bell\u{7} del\u{7f} ls\u{2028}\u{2029} é 日本 😀 </script>";
        let json = s(nasty).render();
        assert!(!json.contains('\n') && !json.contains('\u{2028}') && !json.contains('\u{7}'));
        assert_eq!(json, "\"quote\\\" backslash\\\\ newline\\n tab\\t cr\\r bell\\u0007 del\\u007f ls\\u2028\\u2029 é 日本 😀 </script>\"");
        assert_eq!(opt(None).render(), "null");
        assert_eq!(opt(Some("x".into())).render(), "\"x\"");
    }
}
