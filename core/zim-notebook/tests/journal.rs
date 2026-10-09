//! Journal pages: which names are days, which days of a month have a page, and what a new day starts with.

mod common;
use common::name;
use zim_notebook::{days_in_month, is_leap_year, Day, Notebook, JOURNAL};

fn day(year: u32, month: u32, day: u32) -> Day {
    Day::new(year, month, day).unwrap_or_else(|| panic!("{year}-{month}-{day} is a day"))
}

#[test]
fn leap_years_and_the_length_of_months() {
    for (year, leap) in [(2024, true), (2023, false), (1900, false), (2000, true), (2100, false), (1600, true), (4, true), (1, false)] {
        assert_eq!(is_leap_year(year), leap, "{year}");
        assert_eq!(days_in_month(year, 2), if leap { 29 } else { 28 }, "{year}");
    }
    let lengths: Vec<u32> = (1..=12).map(|m| days_in_month(2026, m)).collect();
    assert_eq!(lengths, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    assert_eq!((days_in_month(2026, 0), days_in_month(2026, 13)), (0, 0));
    // a year adds up
    for year in [1999, 2000, 2024, 2100] {
        let sum: u32 = (1..=12).map(|m| days_in_month(year, m)).sum();
        assert_eq!(sum, if is_leap_year(year) { 366 } else { 365 }, "{year}");
    }
}

#[test]
fn only_days_that_exist_are_days() {
    assert!(Day::new(2024, 2, 29).is_some());
    for (y, m, d) in [(2023, 2, 29), (1900, 2, 29), (2026, 4, 31), (2026, 13, 1), (2026, 0, 1), (2026, 1, 0), (2026, 1, 32), (0, 1, 1), (10000, 1, 1)] {
        assert!(Day::new(y, m, d).is_none(), "{y}-{m}-{d}");
    }
    assert!(Day::new(1, 1, 1).is_some() && Day::new(9999, 12, 31).is_some());
}

#[test]
fn a_day_is_a_page_called_journal_year_month_day() {
    assert_eq!(day(2026, 10, 9).page().as_str(), "Journal:2026:10:09");
    assert_eq!(day(7, 1, 2).page().as_str(), "Journal:0007:01:02");
    // and the name says the day, in any case, only in the form the journal writes it
    assert_eq!(Day::of_page(&name("Journal:2026:10:09")), Some(day(2026, 10, 9)));
    assert_eq!(Day::of_page(&name("journal:2026:10:09")), Some(day(2026, 10, 9)));
    assert_eq!(Day::of_page(&name("JOURNAL:0007:01:02")), Some(day(7, 1, 2)));
    for other in [
        "Journal",
        "Journal:2026",
        "Journal:2026:10",
        "Journal:2026:10:09:Notes", // a page below a day is not the day
        "Journal:2026:1:9",         // not written the way the journal writes it
        "Journal:26:10:09",
        "Journal:2026:10:9",
        "Journal:2026:13:01",
        "Journal:2026:02:30",
        "Journal:2026:10:ab",
        "Journal:2026:+1:09",
        "Journal:2026:10:٠٩", // digits of another script
        "Diary:2026:10:09",
        "Projects:Journal:2026:10:09",
    ] {
        assert_eq!(Day::of_page(&name(other)), None, "{other}");
    }
    // what a day says of itself comes back
    for (y, m, d) in [(2026, 10, 9), (2024, 2, 29), (1999, 12, 31), (1, 1, 1), (9999, 12, 31)] {
        assert_eq!(Day::of_page(&day(y, m, d).page()), Some(day(y, m, d)));
    }
    assert_eq!(JOURNAL, "Journal");
}

#[test]
fn the_weekday_is_right_for_days_that_are_known() {
    // Monday is 0
    for (y, m, d, weekday, called) in [
        (2026, 10, 9, 4, "Friday"),
        (2000, 1, 1, 5, "Saturday"),
        (1970, 1, 1, 3, "Thursday"),
        (2024, 2, 29, 3, "Thursday"),
        (2100, 3, 1, 0, "Monday"),
        (2023, 1, 1, 6, "Sunday"),
        (1900, 1, 1, 0, "Monday"),
    ] {
        let found = day(y, m, d);
        assert_eq!(found.weekday(), weekday, "{y}-{m}-{d}");
        assert!(found.title().starts_with(called), "{}", found.title());
    }
}

#[test]
fn the_weekday_goes_on_by_one_every_day_for_two_centuries() {
    // (an independent check: each day is the day after the one before, whatever either is)
    let mut previous: Option<Day> = None;
    let mut count = 0;
    for year in 1900..=2100 {
        for month in 1..=12 {
            for d in 1..=days_in_month(year, month) {
                let today = day(year, month, d);
                if let Some(before) = previous {
                    assert_eq!(today.weekday(), (before.weekday() + 1) % 7, "{before:?} then {today:?}");
                    // and the order of days is the order of dates
                    assert!(before < today);
                }
                previous = Some(today);
                count += 1;
            }
        }
    }
    assert_eq!(count, 201 * 365 + 49, "days in 1900..=2100 (49 leap years: 1904..=2096 without 1900 and 2100)");
}

#[test]
fn a_day_is_titled_by_its_weekday_date_month_and_year() {
    assert_eq!(day(2026, 10, 9).title(), "Friday 09 October 2026");
    assert_eq!(day(2024, 2, 29).title(), "Thursday 29 February 2024");
    assert_eq!(day(2026, 1, 1).title(), "Thursday 01 January 2026");
    let text = day(2026, 10, 9).page_text("2026-10-09T08:15:00+02:00");
    assert_eq!(
        text,
        "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-09T08:15:00+02:00\n\n====== Friday 09 October 2026 ======\n"
    );
    // (a created time with a line break in it can't break out of the header)
    assert!(!day(2026, 10, 9).page_text("x\nContent-Type: evil").contains("\nContent-Type: evil"));
}

#[test]
fn the_days_of_a_month_that_have_a_page() {
    let mut nb = Notebook::new();
    for page in [
        "Journal:2026:10:09",
        "Journal:2026:10:03",
        "Journal:2026:10:03:Notes", // below a day: not another day
        "Journal:2026:10:31",
        "Journal:2026:09:30",
        "Journal:2026:11:01",
        "Journal:2026:10",       // a page for the month: not a day
        "Journal:2026:1:9",      // not a day
        "journal:2026:10:15",    // another case of the section
        "Projects:Journal:2026:10:20",
        "Other",
    ] {
        nb.put(&name(page), "text\n");
    }
    // a section that only holds pages has no text of its own, so it is not a page
    nb.put(&name("Journal:2026:10:05:Child"), "text\n");
    assert_eq!(nb.journal_days(2026, 10), [3, 9, 15, 31]);
    assert_eq!(nb.journal_days(2026, 9), [30]);
    assert_eq!(nb.journal_days(2026, 12), Vec::<u32>::new());
    assert_eq!(nb.journal_days(2026, 13), Vec::<u32>::new());
    assert_eq!(nb.journal_days(2025, 10), Vec::<u32>::new());
    // pages come and go
    nb.remove(&name("Journal:2026:10:09"));
    assert_eq!(nb.journal_days(2026, 10), [3, 15, 31]);
}
