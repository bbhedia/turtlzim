//! Tables: what a run of `|...|` lines says, and how to change one.
//!
//! The format crate keeps a table as an opaque block (its lines are never rewritten by parsing:
//! `parse(text).serialize() == text`). This module reads such a block, for showing it as a grid and
//! for the commands that edit one, following the syntax Zim writes and reads:
//!
//! ```text
//! | Name  | Count | Note     |      the first line is the header row
//! |:------|------:|:--------:|      optional: `:---` left, `---:` right, `:---:` centred, `---` as it comes
//! | apple |     3 | a\|b     |      one line for each row; `\|` is a pipe in a cell, `\n` a line break in one
//! | pear  |    12 |          |
//! ```
//!
//! A table has a header, optionally the alignment row, and at least one row below. A header cell that
//! ends with `<` marks a column whose cells wrap. Nothing here is applied unless a command asks for it:
//! reading never changes the text, and a table is only laid out again (padded to the width of its columns)
//! when an edit is made to it.

/// How the text of a column sits in its cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Normal,
    Left,
    Right,
    Center,
}

/// A cell of the text: where it is, and what it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    /// The cell as written between its pipes, spaces included (byte offsets in the text read).
    pub start: usize,
    pub end: usize,
    /// What is written in it, without the spaces round it.
    pub raw: String,
    /// What it says: `raw` with `\n`, `\t`, `\\` and `\|` read as the character they stand for.
    pub text: String,
}

/// A line of the table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// Which line of the text it is (the first is 0).
    pub line: usize,
    /// The line, without its line break (byte offsets).
    pub start: usize,
    pub end: usize,
    pub cells: Vec<Cell>,
}

/// A table as it is written in a text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    /// The header row, then the rows below it (the alignment row is not one of them).
    pub rows: Vec<Row>,
    /// The line of the alignment row, if the table has one.
    pub align_line: Option<usize>,
    /// How many columns the widest line has.
    pub columns: usize,
    /// For each column, as the alignment row says (`Normal` for the ones it doesn't mention, or all if there is none).
    pub aligns: Vec<Align>,
    /// For each column, whether its header ends with `<`.
    pub wraps: Vec<bool>,
}

/// A table as what it says, apart from where it is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Table {
    /// The header row, the cells as written (without the spaces round them), and the rows below it. Every row has
    /// as many cells as there are columns.
    pub rows: Vec<Vec<String>>,
    pub aligns: Vec<Align>,
    pub wraps: Vec<bool>,
}

/// Whether `line` can be a line of a table: pipes at both ends.
fn is_table_line(line: &str) -> bool {
    line.len() >= 2 && line.starts_with('|') && line.ends_with('|')
}

/// Whether `line` is an alignment row: only `|`, `-`, `:` and spaces, with at least one `-`.
fn is_align_line(line: &str) -> bool {
    is_table_line(line) && line.contains('-') && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// The cells of `line` (a table line): ranges between its pipes, where a pipe written `\|` is not one.
fn split_cells(line: &str) -> Vec<(usize, usize)> {
    let inner_end = line.len() - 1;
    let mut cells = Vec::new();
    let mut start = 1;
    let mut escaped = false;
    for (at, c) in line.char_indices() {
        if at == 0 || at >= inner_end {
            continue;
        }
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '|' {
            cells.push((start, at));
            start = at + 1;
        }
    }
    cells.push((start, inner_end));
    cells
}

/// `raw` with the escapes read: `\n` is a line break, `\t` a tab, `\\` a backslash, `\|` a pipe; any other
/// backslash is itself.
fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.clone().next() {
            Some('n') => { out.push('\n'); chars.next(); }
            Some('t') => { out.push('\t'); chars.next(); }
            Some('\\') => { out.push('\\'); chars.next(); }
            Some('|') => { out.push('|'); chars.next(); }
            _ => out.push('\\'),
        }
    }
    out
}

/// The alignment a cell of the alignment row says.
fn align_of(cell: &str) -> Align {
    let cell = cell.trim();
    match (cell.starts_with(':'), cell.ends_with(':')) {
        (true, true) if cell.len() > 1 => Align::Center,
        (true, _) => Align::Left,
        (_, true) => Align::Right,
        _ => Align::Normal,
    }
}

/// Read `text`, the lines of a table block, as a table. `None` if it is not one: a table has a header, and at
/// least one row below it (an alignment row does not count as one).
pub fn parse(text: &str) -> Option<Layout> {
    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut at = 0;
    for line in text.split('\n') {
        lines.push((at, line));
        at += line.len() + 1;
    }
    // (a text that ends with its line break has an empty last "line": it is not part of the table)
    if lines.last().map_or(false, |(_, l)| l.is_empty()) && lines.len() > 1 {
        lines.pop();
    }
    if lines.is_empty() || !lines.iter().all(|(_, l)| is_table_line(l)) {
        return None;
    }
    let align_line = if lines.len() > 1 && is_align_line(lines[1].1) { Some(1) } else { None };
    let body_lines = lines.len() - 1 - usize::from(align_line.is_some());
    if body_lines == 0 {
        return None;
    }
    let mut rows = Vec::new();
    for (i, (start, line)) in lines.iter().enumerate() {
        if Some(i) == align_line {
            continue;
        }
        let cells = split_cells(line)
            .into_iter()
            .map(|(from, to)| {
                let raw = line[from..to].trim().to_string();
                Cell { start: start + from, end: start + to, text: unescape(&raw), raw }
            })
            .collect();
        rows.push(Row { line: i, start: *start, end: start + line.len(), cells });
    }
    let columns = rows.iter().map(|r| r.cells.len()).max().unwrap_or(0);
    let mut aligns = vec![Align::Normal; columns];
    if let Some(i) = align_line {
        for (c, (from, to)) in split_cells(lines[i].1).into_iter().enumerate().take(columns) {
            aligns[c] = align_of(&lines[i].1[from..to]);
        }
    }
    let wraps = (0..columns).map(|c| rows[0].cells.get(c).map_or(false, |cell| cell.raw.ends_with('<'))).collect();
    Some(Layout { rows, align_line, columns, aligns, wraps })
}

impl Layout {
    /// What the table says.
    pub fn table(&self) -> Table {
        let rows = self
            .rows
            .iter()
            .map(|row| (0..self.columns).map(|c| row.cells.get(c).map_or(String::new(), |cell| cell.raw.clone())).collect())
            .collect();
        Table { rows, aligns: self.aligns.clone(), wraps: self.wraps.clone() }
    }
}

/// How wide `text` is in characters.
fn width(text: &str) -> usize {
    text.chars().count()
}

/// The narrowest a column is laid out: what an alignment row needs to say what it says.
const MIN_WIDTH: usize = 3;

impl Table {
    /// A table of `columns` columns and `rows` rows below its header, to be filled in.
    pub fn new(columns: usize, rows: usize) -> Table {
        let columns = columns.max(1);
        let mut all = vec![(1..=columns).map(|c| format!("Header {c}")).collect::<Vec<_>>()];
        for _ in 0..rows.max(1) {
            all.push(vec![String::new(); columns]);
        }
        Table { rows: all, aligns: vec![Align::Normal; columns], wraps: vec![false; columns] }
    }

    pub fn columns(&self) -> usize {
        self.aligns.len()
    }

    /// The table written out, every column as wide as its widest cell, an alignment row below the header
    /// (kept only if some column is aligned, or the table had one: `with_align_row`). A first row below the
    /// header that is only dashes, colons and blanks would be read as the alignment row, so then the alignment
    /// row is written too, above it: what is written out always reads as the table it was written from.
    pub fn render(&self, with_align_row: bool) -> String {
        let columns = self.columns();
        let widths: Vec<usize> = (0..columns)
            .map(|c| self.rows.iter().map(|r| width(&r[c])).max().unwrap_or(0).max(MIN_WIDTH))
            .collect();
        let lines: Vec<String> = self
            .rows
            .iter()
            .map(|row| {
                let mut line = String::from("|");
                for c in 0..columns {
                    let text = &row[c];
                    let pad = widths[c] - width(text);
                    let (left, right) = match self.aligns[c] {
                        Align::Right => (pad, 0),
                        Align::Center => (pad / 2, pad - pad / 2),
                        _ => (0, pad),
                    };
                    line.push(' ');
                    line.push_str(&" ".repeat(left));
                    line.push_str(text);
                    line.push_str(&" ".repeat(right));
                    line.push_str(" |");
                }
                line
            })
            .collect();
        let looks_like_the_alignment_row = lines.get(1).map_or(false, |line| is_align_line(line));
        let mut out = Vec::new();
        for (i, line) in lines.into_iter().enumerate() {
            out.push(line);
            if i == 0 && (with_align_row || looks_like_the_alignment_row || self.aligns.iter().any(|a| *a != Align::Normal)) {
                let mut line = String::from("|");
                for c in 0..columns {
                    let dashes = widths[c] + 2;
                    let cell = match self.aligns[c] {
                        Align::Normal => "-".repeat(dashes),
                        Align::Left => format!(":{}", "-".repeat(dashes - 1)),
                        Align::Right => format!("{}:", "-".repeat(dashes - 1)),
                        Align::Center => format!(":{}:", "-".repeat(dashes - 2)),
                    };
                    line.push_str(&cell);
                    line.push('|');
                }
                out.push(line);
            }
        }
        out.join("\n")
    }

    /// A row of empty cells below row `after` (0 is the header; the new row is the first row if `after` is 0).
    pub fn add_row(&mut self, after: usize) {
        let at = after.saturating_add(1).min(self.rows.len());
        self.rows.insert(at, vec![String::new(); self.columns()]);
    }

    /// Remove row `row` (not the header; the last row can't be removed: a table has a row below its header).
    pub fn delete_row(&mut self, row: usize) -> bool {
        if row == 0 || row >= self.rows.len() || self.rows.len() <= 2 {
            return false;
        }
        self.rows.remove(row);
        true
    }

    /// A column of empty cells after column `after` (the first column if there is none: `usize::MAX` for "at the end" is not
    /// special: it is clamped).
    pub fn add_column(&mut self, after: usize) {
        let at = after.saturating_add(1).min(self.columns());
        for (i, row) in self.rows.iter_mut().enumerate() {
            row.insert(at, if i == 0 { format!("Header {}", at + 1) } else { String::new() });
        }
        self.aligns.insert(at, Align::Normal);
        self.wraps.insert(at, false);
    }

    /// Remove column `column` (the last column can't be removed).
    pub fn delete_column(&mut self, column: usize) -> bool {
        if column >= self.columns() || self.columns() <= 1 {
            return false;
        }
        for row in &mut self.rows {
            row.remove(column);
        }
        self.aligns.remove(column);
        self.wraps.remove(column);
        true
    }

    pub fn set_align(&mut self, column: usize, align: Align) -> bool {
        match self.aligns.get_mut(column) {
            Some(slot) => {
                *slot = align;
                true
            }
            None => false,
        }
    }
}
