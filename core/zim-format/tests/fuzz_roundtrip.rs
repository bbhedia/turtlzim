//! The round trip on ARBITRARY text (spec §4: `serialize(parse(text)) == text` "for any input").
//!
//! The other tests check the constructs the spec names. This one checks the promise behind them
//! with text nobody composed: token soup built from the format's own punctuation, which hits
//! unterminated fences, half-open links, markers inside markers and tabs in odd places far more
//! often than uniform random bytes would. It needs no corpus, so it runs in every `cargo test`
//! (`golden_real_notebooks` is the opt-in check against real pages).
//!
//! The generator is a fixed-seed xorshift, so a failure reproduces and CI is deterministic. A
//! failing input is shrunk token by token to a minimal reproduction before it is reported.

use std::time::{Duration, Instant};

mod common;

use common::Rng;

use zim_format::inline::{parse_inline, render_inline};

/// The format's punctuation and the tokens that give it something to bite on.
#[rustfmt::skip]
const TOKENS: &[&str] = &[
    // line structure
    "\n", "\n", "\n", "\n\n", "\r\n", "\r", "\t", "\t", "\t\t", " ", "  ",
    // headings, rules, lists, checkboxes
    "====== ", " ======", "===== ", " =====", "== ", " ==", "=", "= ", "-", "--------------------",
    "* ", "[ ] ", "[*] ", "[x] ", "[>] ", "[<] ", "[ ]", "1. ", "a. ", "A. ", "10. ", "z. ", "0. ",
    // fences and blocks
    "'''", "''", "'", "{{{code: lang=\"python\"", "}}}", "{{{", "| a | b |", "|-----|-----|", "|",
    // inline markup, each half on its own as well as whole
    "**", "//", "__", "~~", "^{", "_{", "{", "}", "[[", "]]", "[", "]", "{{", "}}", "{{id: ", "id:",
    "@", "@tag", "@@", ":", "#", "?", "&", "=v",
    // addresses
    "http://example.org", "https://x.y/z?q=1&r", "mailto:", "a@b.cz", "www.", "file://", "ftp://",
    // headers
    "Content-Type: text/x-zim-wiki", "Wiki-Format: zim 0.6", "Key: value", "Key:", " continued",
    // words and awkward text
    "word", "Word word", "text", "é", "日本語", "😀", "\u{feff}", "\u{0}", "\u{2028}", "\\", "%20",
];

/// Where block structure starts: used by the line-oriented generator so recognizable blocks are
/// common instead of rare.
#[rustfmt::skip]
const LINE_STARTS: &[&str] = &[
    "", "", "", "\t", "\t\t", "\t\t\t", "* ", "\t* ", "\t\t* ", "[ ] ", "\t[x] ", "1. ", "\ta. ", "====== ",
    "=== ", "'''", "\t'''", "\t\t'''", "--------------------", "| a | b |", "{{{code: lang=\"x\"",
    "\t{{{", "}}}", "Content-Type: x", "Key: v", " ", "A paragraph line ",
];

/// The first promise the crate makes about any text that does not hold for `text`, if any: the
/// round trip, a stable parse, the inline round trip, and well-formed syntax spans.
fn problem(text: &str) -> Option<String> {
    let page = zim_format::parse(text);
    let again = page.serialize();
    if again != text {
        return Some(format!("serialize(parse(text)) differs: {again:?}"));
    }
    if zim_format::parse(&again) != page {
        return Some("parse(serialize(parse(text))) != parse(text)".to_string());
    }
    if !text.ends_with(&page.body.serialize()) {
        return Some("the serialized body is not the tail of the text".to_string());
    }
    for tags in [true, false] {
        if render_inline(&parse_inline(text, tags)) != text {
            return Some(format!("inline round trip (tags {tags}) differs"));
        }
    }
    common::span_problem(text).map(|p| format!("spans: {p}"))
}

fn holds(text: &str) -> bool {
    problem(text).is_none()
}

/// Drop tokens one at a time for as long as `fails` still holds without them.
fn shrink(mut tokens: Vec<&'static str>, fails: impl Fn(&str) -> bool) -> Vec<&'static str> {
    loop {
        let mut progressed = false;
        let mut i = 0;
        while i < tokens.len() {
            let mut candidate = tokens.clone();
            candidate.remove(i);
            if fails(&candidate.concat()) {
                tokens = candidate;
                progressed = true;
            } else {
                i += 1;
            }
        }
        if !progressed {
            return tokens;
        }
    }
}

fn check(tokens: Vec<&'static str>, how: &str, case: usize) {
    if holds(&tokens.concat()) {
        return;
    }
    let minimal = shrink(tokens, |t| !holds(t));
    panic!(
        "{how} case {case}: {}\n  minimal input ({} tokens): {:?}\n  as text: {:?}\n  parsed: {:#?}",
        problem(&minimal.concat()).unwrap_or_default(),
        minimal.len(),
        minimal,
        minimal.concat(),
        zim_format::parse(&minimal.concat()),
    );
}

#[test]
fn token_soup_round_trips() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for case in 0..40_000 {
        let n = 1 + rng.below(48);
        let tokens: Vec<&'static str> = (0..n).map(|_| TOKENS[rng.below(TOKENS.len())]).collect();
        check(tokens, "token soup", case);
    }
}

#[test]
fn line_oriented_soup_round_trips() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for case in 0..40_000 {
        let mut tokens: Vec<&'static str> = Vec::new();
        for _ in 0..1 + rng.below(14) {
            tokens.push(LINE_STARTS[rng.below(LINE_STARTS.len())]);
            for _ in 0..rng.below(5) {
                tokens.push(TOKENS[rng.below(TOKENS.len())]);
            }
            tokens.push("\n");
        }
        check(tokens, "line soup", case);
    }
}

/// A page using every construct in the spec, written for this test.
#[rustfmt::skip]
const EVERYTHING: &str = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2099-01-02T03:04:05+00:00\nNote: a header\n\twith a continuation line\n\n====== The Title ======\n\nPlain text with **bold**, //italic//, __underline__, ~~strike~~, ''verbatim'' and x^{2} or H_{2}O.\nA [[Namespace:Page|link]], a [[+child]], a [[#anchor]] and a bare http://example.org/path?q=1 plus mailto:me@example.org and you@example.org.\nA tag @todo and an image {{./pic.png?width=100&height=50|alt text}} and an anchor {{id: here}}.\n\n===== Lists =====\n\n* one\n\t* nested\n\t\t* deeper\n* two\n1. first\n2. second\na. alpha\nA. Alpha\n[ ] open\n[*] done\n[x] dropped\n[>] moved\n[<] moved back\n\n\tAn indented paragraph\n\twith two lines\n\n=== Code ===\n\n'''\nraw **text**\n\tstays //raw//\n\n'''\n\n\t'''\n\tindented\n\n\t'''\n\n--------------------\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n{{{code: lang=\"python\"\nprint(1)\n}}}\n\n== Last ==\ntext with trailing space \n\n\n\nafter three blank lines\n";

#[test]
fn every_prefix_and_suffix_of_a_full_page_round_trips() {
    assert!(holds(EVERYTHING), "the full page itself must round-trip");
    for end in (0..=EVERYTHING.len()).filter(|&i| EVERYTHING.is_char_boundary(i)) {
        assert!(
            holds(&EVERYTHING[..end]),
            "prefix of {end} bytes: {:?}",
            &EVERYTHING[..end]
        );
        assert!(
            holds(&EVERYTHING[end..]),
            "suffix from byte {end}: {:?}",
            &EVERYTHING[end..]
        );
    }
}

#[test]
fn every_single_line_removed_or_doubled_round_trips() {
    let lines: Vec<&str> = EVERYTHING.split('\n').collect();
    for i in 0..lines.len() {
        let mut dropped = lines.clone();
        dropped.remove(i);
        assert!(holds(&dropped.join("\n")), "line {} removed", i + 1);
        let mut doubled = lines.clone();
        doubled.insert(i, lines[i]);
        assert!(holds(&doubled.join("\n")), "line {} doubled", i + 1);
    }
}

/// An editor re-parses between keystrokes, so hostile text must not make that blow up. Known
/// limit, deliberately not "fixed": every unmatched opener (`[[`, `^{`, `_{`...) rescans the rest
/// of its block looking for a closer, so a single block holding *thousands* of unmatched openers
/// costs time quadratic in the block's length (100 KB of `^{` takes tens of seconds). Blocks are
/// parsed one at a time, real pages never look like that, and changing how closers are searched
/// risks changing what gets parsed, so the cost stays. What this test pins down is that nothing
/// is worse than quadratic: 10 KB of each hostile shape must parse in seconds even in an
/// unoptimized build, where cubic or exponential behaviour would take hours.
#[test]
fn hostile_pages_parse_in_bounded_time() {
    const BYTES: usize = 10_000;
    // (quadratic is a second or two here, in an unoptimized build; cubic is hours. The budget is wide because this runs beside
    // other tests on two cores, and a busy machine has failed it at 5 seconds; the point is a blow-up, not a stopwatch.)
    const BUDGET: Duration = Duration::from_secs(25);
    let units: &[&str] = &[
        "**",
        "//",
        "__",
        "~~",
        "**a //",
        "**a //b ",
        "[[",
        "[[a|",
        "]]",
        "{{",
        "{{id: ",
        "}}",
        "^{",
        "_{",
        "}",
        "@",
        "a@",
        "http://",
        "'''\n",
        "''",
        "'",
        "\t'''\n",
        "\t",
        "=",
        "====== ",
        "-",
        "* ",
        "\t* [ ] x\n",
        "| a ",
        "{{{code\n",
        "}}}\n",
        "\n",
        "Key: v\n\t",
        "[[a]] **b** ''c'' @d ",
        "\r\n",
    ];
    let mut too_slow = Vec::new();
    for unit in units {
        let text = unit.repeat(BYTES / unit.len());
        let started = Instant::now();
        let page = zim_format::parse(&text);
        let again = page.serialize();
        let mut took = started.elapsed();
        // (a busy machine slows a good parser too, and this has failed for that reason when other work was running: a
        // parser that is worse than linear is slow every time, so a slow page is measured again, and the best time counts)
        for _ in 0..2 {
            if took < BUDGET {
                break;
            }
            let started = Instant::now();
            let _ = zim_format::parse(&text).serialize();
            took = took.min(started.elapsed());
        }
        assert_eq!(
            again,
            text,
            "{unit:?} repeated to {} bytes did not round-trip",
            text.len()
        );
        if took >= BUDGET {
            too_slow.push(format!(
                "{unit:?} repeated to {} bytes took {took:?}",
                text.len()
            ));
        }
    }
    assert!(
        too_slow.is_empty(),
        "worse than quadratic?\n{}",
        too_slow.join("\n")
    );
}
