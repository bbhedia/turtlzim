//! Tables: reading a table block, where each cell is, and the edits that lay one out again.

use zim_format::table::{parse, Align, Table};

/// A fixed-seed generator, so a failure reproduces.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn cells(text: &str, row: usize) -> Vec<String> {
    parse(text).unwrap().rows[row].cells.iter().map(|c| c.raw.clone()).collect()
}

#[test]
fn a_table_is_a_header_and_rows_below_it() {
    let text = "| Name | Count |\n| apple | 3 |\n| pear | 12 |";
    let layout = parse(text).expect("a table");
    assert_eq!((layout.columns, layout.rows.len(), layout.align_line), (2, 3, None));
    assert_eq!(cells(text, 0), ["Name", "Count"]);
    assert_eq!(cells(text, 2), ["pear", "12"]);
    assert_eq!(layout.aligns, [Align::Normal, Align::Normal]);
    // a line break at the end is not another line
    assert_eq!(parse(&format!("{text}\n")).unwrap(), layout);
    // cells need no spaces round them, and may be empty
    let tight = "|a||c|\n||b||";
    assert_eq!(cells(tight, 0), ["a", "", "c"]);
    assert_eq!(cells(tight, 1), ["", "b", ""]);
    assert_eq!(parse(tight).unwrap().columns, 3);
}

#[test]
fn what_is_not_a_table_is_not_read_as_one() {
    for text in [
        "",
        "|",
        "||",
        "| just a header |",                  // nothing below it
        "| header |\n|---|",                  // an alignment row is not a row
        "| header |\n|:---|---:|",
        "| a |\nno pipes here\n| c |",        // a line that is not a table line
        "| a |\n| b",
        "text",
        "| a |\n\n| b |",                     // a blank line ends a table: these are two blocks
    ] {
        assert!(parse(text).is_none(), "{text:?}");
    }
    // a header, an alignment row and a row is
    assert!(parse("| a |\n|---|\n| b |").is_some());
    // a second line that only looks like an alignment row is a row if it has no dash
    let layout = parse("| a | b |\n| : | : |\n| c | d |").unwrap();
    assert_eq!((layout.rows.len(), layout.align_line), (3, None));
}

#[test]
fn a_bar_alone_is_not_a_line_of_a_table() {
    assert!(parse("| a |\n|\n| b |").is_none());
    assert!(parse("|\n| a |\n| b |").is_none());
    assert!(parse("| a |\n| b |\n|").is_none());
}

#[test]
fn only_dashes_colons_bars_and_spaces_make_an_alignment_row() {
    // (a letter in the second line makes it a row of the table)
    let text = "| a | b |\n|-x-|---|";
    let layout = parse(text).expect("a table: the second line is a row");
    assert_eq!((layout.rows.len(), layout.align_line), (2, None));
    assert_eq!(cells(text, 1), ["-x-", "---"]);
}

#[test]
fn a_colon_alone_in_the_alignment_row_is_the_left() {
    // (a colon at each end of a cell is the centre; one colon is the left, even when it is all the cell has)
    let layout = parse("| a | b |\n|:--|:|\n| c | d |").unwrap();
    assert_eq!(layout.aligns, [Align::Left, Align::Left]);
}

#[test]
fn a_row_that_looks_like_the_alignment_row_stays_a_row_when_it_is_written_out() {
    // (a row of dashes under the header is by the format's own rule the alignment row, so the table is written with one above it)
    let table = Table { rows: vec![vec!["Name".into(), "Count".into()], vec!["-".into(), ":-".into()], vec!["a".into(), "1".into()]], aligns: vec![Align::Normal; 2], wraps: vec![false; 2] };
    let written = table.render(false);
    assert_eq!(written, "| Name | Count |\n|------|-------|\n| -    | :-    |\n| a    | 1     |");
    let layout = parse(&written).unwrap();
    assert_eq!((layout.rows.len(), layout.align_line), (3, Some(1)));
    assert_eq!(layout.table(), table);
    // a table that has the dashes in a row further down is written as it is
    let lower = Table { rows: vec![vec!["Name".into(), "Count".into()], vec!["a".into(), "1".into()], vec!["-".into(), "-".into()]], aligns: vec![Align::Normal; 2], wraps: vec![false; 2] };
    assert_eq!(lower.render(false), "| Name | Count |\n| a    | 1     |\n| -    | -     |");
}

#[test]
fn a_column_is_at_least_three_characters_wide() {
    let table = Table { rows: vec![vec!["a".into(), "b".into()], vec!["c".into(), "d".into()]], aligns: vec![Align::Normal; 2], wraps: vec![false; 2] };
    assert_eq!(table.render(false), "| a   | b   |\n| c   | d   |");
    assert_eq!(table.render(true), "| a   | b   |\n|-----|-----|\n| c   | d   |");
}

#[test]
fn the_alignment_row_says_how_each_column_sits() {
    let layout = parse("| a | b | c | d | e |\n|:--|--:|:-:|---|:---:|\n| 1 | 2 | 3 | 4 | 5 |").unwrap();
    assert_eq!(layout.align_line, Some(1));
    assert_eq!(layout.rows.len(), 2);
    assert_eq!(layout.aligns, [Align::Left, Align::Right, Align::Center, Align::Normal, Align::Center]);
    // columns it doesn't mention are as they come
    let layout = parse("| a | b | c |\n|--:|\n| 1 | 2 | 3 |").unwrap();
    assert_eq!(layout.aligns, [Align::Right, Align::Normal, Align::Normal]);
    // and a ragged table has as many columns as its widest line
    let layout = parse("| a |\n| 1 | 2 | 3 |").unwrap();
    assert_eq!(layout.columns, 3);
    assert_eq!(layout.table().rows, [vec!["a", "", ""], vec!["1", "2", "3"]]);
}

#[test]
fn a_header_that_ends_with_a_less_than_sign_is_a_column_that_wraps() {
    let layout = parse("| Name< | Count |\n| a long text | 3 |").unwrap();
    assert_eq!(layout.wraps, [true, false]);
    assert_eq!(layout.rows[0].cells[0].raw, "Name<", "it is kept as written");
}

#[test]
fn escapes_are_read_and_kept() {
    let text = "| a\\|b | c\\\\|d |\n| line\\nbreak | tab\\there \\x |";
    let layout = parse(text).unwrap();
    let first = &layout.rows[0].cells;
    // a pipe written \| is part of the cell, and \\ is a backslash, so the pipe after it ends the cell
    assert_eq!(first.len(), 3, "{first:?}");
    assert_eq!((first[0].raw.as_str(), first[0].text.as_str()), ("a\\|b", "a|b"));
    assert_eq!((first[1].raw.as_str(), first[1].text.as_str()), ("c\\\\", "c\\"));
    assert_eq!(first[2].raw, "d");
    let second = &layout.rows[1].cells;
    assert_eq!(second[0].text, "line\nbreak");
    assert_eq!(second[1].text, "tab\there \\x", "an escape that means nothing is as written");
    // a backslash at the end of a cell is itself
    assert_eq!(parse("|a\\|\n|b|").unwrap().rows[0].cells[0].text, "a\\");
}

#[test]
fn every_cell_says_where_it_is_in_the_text() {
    let text = "| héllo | 日本語 |\n|:--|--:|\n| a | b\\|c |";
    let layout = parse(text).unwrap();
    for row in &layout.rows {
        // the line is its cells and the pipes between them, to the byte
        let line = &text[row.start..row.end];
        let mut rebuilt = String::from("|");
        for cell in &row.cells {
            assert!(text.is_char_boundary(cell.start) && text.is_char_boundary(cell.end));
            rebuilt.push_str(&text[cell.start..cell.end]);
            rebuilt.push('|');
        }
        assert_eq!(rebuilt, line);
        assert_eq!(text[row.start..].lines().next().unwrap(), line);
        for cell in &row.cells {
            assert_eq!(text[cell.start..cell.end].trim(), cell.raw);
        }
    }
    assert_eq!(layout.rows[0].line, 0);
    assert_eq!(layout.rows[1].line, 2, "the alignment row is line 1");
}

#[test]
fn a_table_is_laid_out_with_its_columns_as_wide_as_their_widest_cell() {
    let table = parse("|Name|Count|\n|apple|3|\n|pear|12|").unwrap().table();
    assert_eq!(table.render(false), "| Name  | Count |\n| apple | 3     |\n| pear  | 12    |");
    // aligned columns: an alignment row, and the text sits as it says
    let mut aligned = table.clone();
    aligned.set_align(0, Align::Left);
    aligned.set_align(1, Align::Right);
    assert_eq!(aligned.render(false), "| Name  | Count |\n|:------|------:|\n| apple |     3 |\n| pear  |    12 |");
    aligned.set_align(0, Align::Center);
    assert_eq!(aligned.render(false), "| Name  | Count |\n|:-----:|------:|\n| apple |     3 |\n| pear  |    12 |");
    // an alignment row is kept if the table had one, with nothing aligned
    assert_eq!(table.render(true), "| Name  | Count |\n|-------|-------|\n| apple | 3     |\n| pear  | 12    |");
    // characters are counted, not bytes
    let wide = parse("|héllo|日本語|\n|a|b|").unwrap().table();
    assert_eq!(wide.render(false), "| héllo | 日本語 |\n| a     | b   |");
    // a table that is laid out is laid out the same again, and says the same
    for text in [aligned.render(false), table.render(true), table.render(false)] {
        let again = parse(&text).unwrap();
        assert_eq!(again.table().render(again.align_line.is_some()), text);
    }
}

#[test]
fn rows_and_columns_are_added_and_taken_away() {
    let mut table = parse("| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |").unwrap().table();
    table.add_row(0);
    assert_eq!(table.rows[1], ["", ""], "below the header");
    table.add_row(2);
    assert_eq!(table.rows.len(), 5);
    assert_eq!(table.rows[3], ["", ""]);
    table.add_row(99);
    assert_eq!(table.rows.len(), 6, "past the end is at the end");
    table.add_row(usize::MAX);
    assert_eq!(table.rows.len(), 7, "however far past: a number from outside (a JavaScript -1 is that) must not wrap round to the top");
    assert!(table.delete_row(6));
    assert!(!table.delete_row(0), "not the header");
    assert!(!table.delete_row(99));
    assert!(table.delete_row(1) && table.delete_row(2));
    assert_eq!(table.rows.len(), 4);

    let mut table = parse("| a | b |\n|:--|--:|\n| 1 | 2 |").unwrap().table();
    table.add_column(0);
    assert_eq!(table.rows, [vec!["a", "Header 2", "b"], vec!["1", "", "2"]]);
    assert_eq!(table.aligns, [Align::Left, Align::Normal, Align::Right]);
    table.add_column(99);
    assert_eq!(table.columns(), 4);
    table.add_column(usize::MAX);
    assert_eq!(table.columns(), 5, "and the same for a column");
    assert!(table.delete_column(4));
    assert!(table.delete_column(1));
    assert_eq!(table.rows[0], ["a", "b", "Header 4"]);
    assert_eq!(table.aligns, [Align::Left, Align::Right, Align::Normal]);
    assert!(!table.delete_column(9));
    let mut one = Table::new(1, 1);
    assert!(!one.delete_column(0), "a table keeps a column");
    assert!(!one.delete_row(1), "and a row below its header");
    assert!(!one.set_align(5, Align::Left));
}

#[test]
fn a_new_table_is_a_table() {
    let text = Table::new(3, 2).render(true);
    assert_eq!(
        text,
        "| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n|          |          |          |\n|          |          |          |"
    );
    let layout = parse(&text).unwrap();
    assert_eq!((layout.columns, layout.rows.len(), layout.align_line), (3, 3, Some(1)));
    // never smaller than a table can be
    assert_eq!(Table::new(0, 0).columns(), 1);
    assert!(parse(&Table::new(0, 0).render(true)).is_some());
}

fn random_cell(rng: &mut Rng) -> String {
    const PIECES: &[&str] = &["a", "bb", "x y", "\\|", "\\\\", "\\n", "é", "日本", "**bold**", "//it//", "[[Page]]", "@tag", "'", "1.5", "w"];
    (0..rng.below(4)).map(|_| PIECES[rng.below(PIECES.len())]).collect::<Vec<_>>().join(" ")
}

fn random_table(rng: &mut Rng) -> Table {
    let columns = 1 + rng.below(5);
    let rows = 2 + rng.below(5);
    let mut table = Table::new(columns, rows - 1);
    for row in table.rows.iter_mut() {
        for cell in row.iter_mut() {
            *cell = random_cell(rng);
        }
    }
    // (a header cell with nothing in it would be written as a blank, which is a cell all the same)
    for c in 0..columns {
        let align = [Align::Normal, Align::Left, Align::Right, Align::Center][rng.below(4)];
        table.aligns[c] = align;
        table.wraps[c] = table.rows[0][c].ends_with('<');
    }
    table
}

#[test]
fn what_is_written_is_read_back_whatever_is_in_the_cells() {
    let mut rng = Rng(0x7ab1_e5ee_d00d_f00d);
    for round in 0..300 {
        let table = random_table(&mut rng);
        let text = table.render(rng.below(2) == 0);
        let layout = parse(&text).unwrap_or_else(|| panic!("round {round}: not a table: {text:?}"));
        assert_eq!(layout.table(), table, "round {round}: {text:?}");
        // laying it out again changes nothing
        assert_eq!(layout.table().render(layout.align_line.is_some()), text, "round {round}");
        // the cells say where they are
        for row in &layout.rows {
            let line = &text[row.start..row.end];
            let mut rebuilt = String::from("|");
            for cell in &row.cells {
                rebuilt.push_str(&text[cell.start..cell.end]);
                rebuilt.push('|');
            }
            assert_eq!(rebuilt, line, "round {round}");
        }
        // and the text is a table block as far as the format crate is concerned, whatever else is round it
        let page = format!("before\n\n{text}\n\nafter\n");
        assert_eq!(zim_format::parse(&page).serialize(), page, "round {round}");
    }
}

/// Text that was made to break a reader of tables: bars, backslashes, dashes, colons and angle signs in every order, blanks of
/// every kind, line breaks and carriage returns, a NUL, and characters of one, two, three and four bytes. Whatever it is
/// (a table, or nothing like one), reading it and writing it out again never panics, every cell is where it says it is, and
/// what is written out is read back as the same table.
#[test]
fn hostile_text_is_read_without_a_panic_and_every_place_it_names_is_in_the_text() {
    const PIECES: &[&str] = &["|", "|", "||", " ", "\t", "-", "--", ":", "<", "\\", "\\|", "\n", "\r", "\u{0}", "a", "é", "日", "😀", "\u{200d}", "\u{2028}", "|-|", "|:-:|", "\n|", "|\n"];
    let mut rng = Rng(0x4057_11e5_7e87_0042);
    let (mut tables, mut texts) = (0usize, 0usize);
    for round in 0..20_000 {
        // (lines with a bar at each end, filled with the pieces, mostly: a text that is nothing like a table is not what breaks a reader of them)
        let lines: Vec<String> = (0..1 + rng.below(5))
            .map(|_| {
                let inner: String = (0..rng.below(14)).map(|_| PIECES[rng.below(PIECES.len())]).collect();
                if rng.below(10) == 0 { inner } else { format!("|{inner}|") }
            })
            .collect();
        let text = lines.join("\n");
        texts += 1;
        let Some(layout) = parse(&text) else { continue };
        tables += 1;
        for row in &layout.rows {
            assert!(text.get(row.start..row.end).is_some(), "round {round}: a row is not in the text: {text:?}");
            for cell in &row.cells {
                let written = text.get(cell.start..cell.end).unwrap_or_else(|| panic!("round {round}: a cell is not in the text: {text:?}"));
                assert_eq!(written.trim(), cell.raw, "round {round}: {text:?}");
            }
        }
        let table = layout.table();
        let written = table.render(layout.align_line.is_some());
        let again = parse(&written).unwrap_or_else(|| panic!("round {round}: {text:?} written out again is not a table: {written:?}"));
        assert_eq!(again.table().rows, table.rows, "round {round}: {text:?}");
        // every edit, at every place there is and past the end of it, leaves a table (or refuses)
        for at in 0..=layout.columns + 1 {
            let mut edited = table.clone();
            edited.add_row(at);
            edited.add_column(at);
            assert!(parse(&edited.render(true)).is_some(), "round {round}: {text:?}");
            let mut cut = table.clone();
            let _ = (cut.delete_row(at), cut.delete_column(at), cut.set_align(at, Align::Center));
            assert!(parse(&cut.render(false)).is_some(), "round {round}: {text:?}");
        }
    }
    assert!(tables > 1_000, "only {tables} of {texts} texts were tables: the alphabet does not make tables");
}

#[test]
fn reading_never_changes_what_is_read() {
    // (the text a table is read from is only ever looked at: the editor keeps it as it is until an edit asks for another)
    let mut rng = Rng(0x0dd5_ca1e_ba5e_ba11);
    for _ in 0..200 {
        let table = random_table(&mut rng);
        let mut text = table.render(false);
        // damage it: drop or double a character
        if !text.is_empty() {
            let at = rng.below(text.len());
            if text.is_char_boundary(at) {
                if rng.below(2) == 0 {
                    text.remove(at);
                } else {
                    let c = text[at..].chars().next().unwrap();
                    text.insert(at, c);
                }
            }
        }
        let before = text.clone();
        let _ = parse(&text);
        assert_eq!(text, before);
        if let Some(layout) = parse(&text) {
            for row in &layout.rows {
                assert!(row.start <= row.end && row.end <= text.len());
                for cell in &row.cells {
                    assert!(text.is_char_boundary(cell.start) && text.is_char_boundary(cell.end) && cell.start <= cell.end);
                }
            }
        }
    }
}
