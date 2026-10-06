//! A page as plain text: what is left when the header and the syntax are tidied away.

mod common;
use zim_format::plain_text;

#[test]
fn the_header_and_the_syntax_characters_are_left_out() {
    let text = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:00:00+00:00\n\n====== The Title ======\nSome **bold**, //italic// and ''code'' with H_{2}O.\n";
    assert_eq!(plain_text(text), "The Title\nSome bold, italic and code with H2O.\n");
}

#[test]
fn lists_links_and_the_rest() {
    let text = "* bullet\n\t[*] done task\n1. numbered\n[[Page]] and [[Other:Page|shown text]] and [[#here]], @tag, https://example.org/a\n{{./pic.png?width=3|alt}}{{id: spot}}\n--------------------\nend\n";
    assert_eq!(plain_text(text), "bullet\n\tdone task\nnumbered\nPage and shown text and #here, @tag, https://example.org/a\n\n\nend\n");
}

#[test]
fn code_and_tables_keep_their_content() {
    let text = "'''\n**not markup** [[nor this]]\n'''\n| a | b |\n{{{code: lang=\"x\"\nbody\n}}}\n";
    assert_eq!(plain_text(text), "\n**not markup** [[nor this]]\n\n| a | b |\n{{{code: lang=\"x\"\nbody\n}}}\n");
}

#[test]
fn text_with_no_markup_is_unchanged() {
    for text in ["", "plain words\nand more\n", "no trailing newline", "日本語 and é and 😀\n"] {
        assert_eq!(plain_text(text), text);
    }
}

#[test]
fn a_page_with_only_a_header_has_no_text() {
    assert_eq!(plain_text("Content-Type: text/x-zim-wiki\n\n"), "");
}

#[test]
fn it_never_grows_and_never_fails_on_any_text() {
    // the fuzzers' kind of text: half-open markers, tabs, stray fences
    let pieces = ["**", "//", "[[", "]]", "|", "{{", "}}", "'''", "''", "\n", "\t", "* ", "[ ] ", "====== ", "a", "é", "😀", "@x", "http://x.y", "Content-Type: x\n\n"];
    let mut rng = common::Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..20_000 {
        let text: String = (0..rng.below(30)).map(|_| pieces[rng.below(pieces.len())]).collect();
        let plain = plain_text(&text);
        assert!(plain.len() <= text.len(), "{text:?} -> {plain:?}");
        // what is left is a subsequence of the text: nothing was invented or reordered
        let mut rest = text.chars();
        assert!(plain.chars().all(|c| rest.any(|t| t == c)), "{text:?} -> {plain:?}");
    }
}
