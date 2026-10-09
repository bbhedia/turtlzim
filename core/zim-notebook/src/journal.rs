//! Journal pages: one page for each day, named the way Zim's journal plugin names them,
//! `Journal:2026:10:09` (a four-digit year, a two-digit month and day, as `%Y:%m:%d` writes them).
//!
//! What a name has to look like to be a day, which days of a month have a page, and what a new day's
//! page starts with are rules of the notebook, so they are here and not in each shell. Choosing which
//! day is today is the shell's: only it knows the time zone.

use crate::name::PageName;
use crate::notebook::{page_text_titled, Notebook};

/// The section the days are pages of.
pub const JOURNAL: &str = "Journal";

const WEEKDAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// Whether `year` has a 29th of February (the Gregorian rule).
pub fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// How many days `month` (1 to 12) of `year` has; 0 if there is no such month.
pub fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// A day of the calendar: year 1 to 9999, a month that exists and a day it has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Day {
    pub year: u32,
    pub month: u32,
    pub day: u32,
}

impl Day {
    /// The day, if there is one.
    pub fn new(year: u32, month: u32, day: u32) -> Option<Day> {
        if !(1..=9999).contains(&year) || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Day { year, month, day })
    }

    /// The page of the day: `Journal:2026:10:09`.
    pub fn page(&self) -> PageName {
        PageName::parse(&format!("{JOURNAL}:{:04}:{:02}:{:02}", self.year, self.month, self.day)).expect("a journal name is a valid name")
    }

    /// The day a page is the page of: exactly `Journal:YYYY:MM:DD` (the section's name in any case), with the
    /// digits written the way the journal writes them, of a date that exists. `Journal:2026:1:9` is a page
    /// like any other.
    pub fn of_page(name: &PageName) -> Option<Day> {
        let levels: Vec<&str> = name.levels().collect();
        if levels.len() != 4 || !levels[0].eq_ignore_ascii_case(JOURNAL) {
            return None;
        }
        let number = |text: &str, width: usize| -> Option<u32> {
            if text.len() == width && text.bytes().all(|b| b.is_ascii_digit()) {
                text.parse().ok()
            } else {
                None
            }
        };
        Day::new(number(levels[1], 4)?, number(levels[2], 2)?, number(levels[3], 2)?)
    }

    /// 0 for Monday to 6 for Sunday.
    pub fn weekday(&self) -> u32 {
        // Sakamoto's method (0 is Sunday there)
        const T: [u32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
        let y = if self.month < 3 { self.year - 1 } else { self.year };
        let sunday_first = (y + y / 4 - y / 100 + y / 400 + T[(self.month - 1) as usize] + self.day) % 7;
        (sunday_first + 6) % 7
    }

    /// What the day is called at the top of its page: `Friday 09 October 2026`.
    pub fn title(&self) -> String {
        format!("{} {:02} {} {}", WEEKDAYS[self.weekday() as usize], self.day, MONTHS[(self.month - 1) as usize], self.year)
    }

    /// The text a new journal page starts with: the header and the day as its title. `created` is a time
    /// like `2026-10-06T09:41:03+02:00`.
    pub fn page_text(&self, created: &str) -> String {
        page_text_titled(&self.title(), created)
    }
}

impl Notebook {
    /// The days of a month that have a page with text, as day numbers in order.
    pub fn journal_days(&self, year: u32, month: u32) -> Vec<u32> {
        (1..=days_in_month(year, month))
            .filter_map(|day| Day::new(year, month, day))
            .filter(|day| self.has_page(&day.page()))
            .map(|day| day.day)
            .collect()
    }
}
