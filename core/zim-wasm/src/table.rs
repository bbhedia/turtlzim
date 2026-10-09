//! Tables for JavaScript: what a table block says (where each cell is, how the columns are aligned) and the
//! edits the editor offers (rows and columns added and removed, alignment, the columns padded). See
//! `zim_format::table`. Every edit is given the text of the table block (its lines, without the line break
//! after the last) and answers with the text to put in its place, or nothing if it can't be done.

use wasm_bindgen::prelude::*;
use zim_format::table::{self, Align, Layout};
use zim_format::utf16_offsets;

use crate::json::{s, J};

fn align_name(align: Align) -> &'static str {
    match align {
        Align::Normal => "normal",
        Align::Left => "left",
        Align::Right => "right",
        Align::Center => "center",
    }
}

fn align_from(name: &str) -> Option<Align> {
    match name {
        "normal" => Some(Align::Normal),
        "left" => Some(Align::Left),
        "right" => Some(Align::Right),
        "center" => Some(Align::Center),
        _ => None,
    }
}

fn layout_json(layout: &Layout, text: &str) -> J {
    let at = utf16_offsets(text);
    J::Obj(vec![
        ("columns", J::Num(layout.columns)),
        ("alignLine", layout.align_line.map_or(J::Null, J::Num)),
        ("aligns", J::Arr(layout.aligns.iter().map(|a| s(align_name(*a))).collect())),
        ("wraps", J::Arr(layout.wraps.iter().map(|w| J::Bool(*w)).collect())),
        (
            "rows",
            J::Arr(
                layout
                    .rows
                    .iter()
                    .map(|row| {
                        J::Obj(vec![
                            ("line", J::Num(row.line)),
                            ("start", J::Num(at[row.start])),
                            ("end", J::Num(at[row.end])),
                            (
                                "cells",
                                J::Arr(
                                    row.cells
                                        .iter()
                                        .map(|cell| {
                                            J::Obj(vec![
                                                ("start", J::Num(at[cell.start])),
                                                ("end", J::Num(at[cell.end])),
                                                ("raw", s(cell.raw.as_str())),
                                                ("text", s(cell.text.as_str())),
                                            ])
                                        })
                                        .collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// The table in `text` (the lines of a table block), as JSON:
/// `{columns, alignLine, aligns, wraps, rows: [{line, start, end, cells: [{start, end, raw, text}]}]}`, the
/// header the first row, offsets in UTF-16 units. Nothing if it is not a table (a header, and a row below it).
#[wasm_bindgen(js_name = tableLayout)]
pub fn table_layout(text: &str) -> Option<String> {
    table::parse(text).map(|layout| layout_json(&layout, text).render())
}

/// Apply `edit` to the table in `text` and write it out again, every column as wide as its widest cell.
fn edit(text: &str, change: impl FnOnce(&mut table::Table) -> bool) -> Option<String> {
    let layout = table::parse(text)?;
    let had_align_row = layout.align_line.is_some();
    let mut model = layout.table();
    if change(&mut model) {
        Some(model.render(had_align_row))
    } else {
        None
    }
}

/// The table written out again, padded to the width of its columns.
#[wasm_bindgen(js_name = tableFormat)]
pub fn table_format(text: &str) -> Option<String> {
    edit(text, |_| true)
}

/// A new row of empty cells below row `after` (0 is the header).
#[wasm_bindgen(js_name = tableAddRow)]
pub fn table_add_row(text: &str, after: usize) -> Option<String> {
    edit(text, |t| {
        t.add_row(after);
        true
    })
}

/// Row `row` removed (not the header, and not the last row below it).
#[wasm_bindgen(js_name = tableDeleteRow)]
pub fn table_delete_row(text: &str, row: usize) -> Option<String> {
    edit(text, |t| t.delete_row(row))
}

/// A new column of empty cells after column `after`.
#[wasm_bindgen(js_name = tableAddColumn)]
pub fn table_add_column(text: &str, after: usize) -> Option<String> {
    edit(text, |t| {
        t.add_column(after);
        true
    })
}

/// Column `column` removed (not the last column).
#[wasm_bindgen(js_name = tableDeleteColumn)]
pub fn table_delete_column(text: &str, column: usize) -> Option<String> {
    edit(text, |t| t.delete_column(column))
}

/// Column `column` aligned `normal`, `left`, `right` or `center`.
#[wasm_bindgen(js_name = tableSetAlign)]
pub fn table_set_align(text: &str, column: usize, align: &str) -> Option<String> {
    let align = align_from(align)?;
    edit(text, |t| t.set_align(column, align))
}

/// The text of a new table of `columns` columns and `rows` rows below its header, with an alignment row.
#[wasm_bindgen(js_name = tableNew)]
pub fn table_new(columns: usize, rows: usize) -> String {
    table::Table::new(columns.min(20), rows.min(100)).render(true)
}
