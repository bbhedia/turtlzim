// The calendar in the sidebar: a month of days, the ones that have a journal page marked, a day
// to open (its page is made when something is written in it), and "Today". Which pages are the days'
// is the notebook's rule (`journalPage`, `journalDays`); this only draws them.
import type { JournalDay } from "../notebook-core";
import { clear, h } from "./dom";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Today, by the clock of this computer. */
export function localToday(): JournalDay {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * A date of the calendar as the browser has it. (`Date.UTC(50, 0, 1)` is a day of 1950: for a year below 100 the
 * year has to be set after the date is made.)
 */
function utc(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** How many days `month` (1 to 12) of `year` has. */
export function daysInMonth(year: number, month: number): number {
  return utc(year, month + 1, 0).getUTCDate();
}

/** 0 for Monday to 6 for Sunday. */
export function weekdayOf(year: number, month: number, day: number): number {
  return (utc(year, month, day).getUTCDay() + 6) % 7;
}

/** The date `days` days after (or before) a date, or the same date if that is not a year of the calendar (1 to 9999). */
export function addDays(date: JournalDay, days: number): JournalDay {
  const moved = utc(date.year, date.month, date.day + days);
  const year = moved.getUTCFullYear();
  return year < 1 || year > 9999 ? date : { year, month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** The weeks of a month, Monday first: seven cells each, a day number or null where the week is another month's. */
export function monthWeeks(year: number, month: number): Array<Array<number | null>> {
  const first = weekdayOf(year, month, 1);
  const cells: Array<number | null> = [...Array<null>(first).fill(null), ...Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** The month before or after (a year is 1 to 9999: past either end it stays). */
export function neighbourMonth(year: number, month: number, step: -1 | 1): { year: number; month: number } {
  const index = year * 12 + (month - 1) + step;
  const moved = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  return moved.year < 1 || moved.year > 9999 ? { year, month } : moved;
}

export interface CalendarHost {
  /** The days of a month that have a page. */
  daysWithPages(year: number, month: number): number[];
  /** A day was chosen. */
  open(day: JournalDay): void;
}

const sameDay = (a: JournalDay | undefined, b: JournalDay): boolean => !!a && a.year === b.year && a.month === b.month && a.day === b.day;

/** The same day in the month before or after (the last day it has, if it has fewer). */
function monthStep(date: JournalDay, step: -1 | 1): JournalDay {
  const next = neighbourMonth(date.year, date.month, step);
  return { ...next, day: Math.min(date.day, daysInMonth(next.year, next.month)) };
}

export class CalendarPanel {
  readonly element: HTMLDetailsElement;
  private readonly body = h("div", { class: "calendar" });
  /** The month's name, kept from one drawing to the next so that a reader of the screen is told when it changes. */
  private readonly title = h("span", { class: "calendar-title", "aria-live": "polite" });
  private view: { year: number; month: number };
  private selected: JournalDay | undefined;

  constructor(
    private readonly host: CalendarHost,
    private readonly now: () => JournalDay = localToday,
    open = true,
  ) {
    const today = this.now();
    this.view = { year: today.year, month: today.month };
    this.element = h("details", { class: "panel calendar-panel", open }, h("summary", {}, "Calendar"), this.body);
    this.body.addEventListener("keydown", (event) => this.onKey(event));
    this.render();
  }

  /** The page that is open is the page of `day` (or of no day): its month is shown, and it is marked. */
  select(day: JournalDay | undefined): void {
    this.selected = day;
    if (day) this.view = { year: day.year, month: day.month };
    this.render();
  }

  /** Pages came or went: the days that have one are drawn again. */
  refresh(): void {
    this.render();
  }

  /** Show nothing of the notebook (its pages' days) until the next `refresh`. */
  clear(): void {
    this.selected = undefined;
    clear(this.body);
  }

  private go(step: -1 | 1): void {
    this.view = neighbourMonth(this.view.year, this.view.month, step);
    this.render();
    // (the button that was pressed is drawn again: the focus stays on it)
    this.body.querySelector<HTMLElement>(`[aria-label="${step === 1 ? "Next month" : "Previous month"}"]`)?.focus();
  }

  /** The arrows move from day to day, Home and End to the ends of the week, Page Up and Down to the month before and after. */
  private onKey(event: KeyboardEvent): void {
    const stamp = (event.target as HTMLElement).dataset?.date;
    if (!stamp || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const [year, month, day] = stamp.split("-").map(Number) as [number, number, number];
    const from = { year, month, day };
    const weekday = weekdayOf(year, month, day);
    const moves: Record<string, () => JournalDay> = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      Home: () => addDays(from, -weekday),
      End: () => addDays(from, 6 - weekday),
      PageUp: () => monthStep(from, -1),
      PageDown: () => monthStep(from, 1),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const to = move();
    if (to.year !== this.view.year || to.month !== this.view.month) {
      this.view = { year: to.year, month: to.month };
      this.render();
    }
    const buttons = [...this.body.querySelectorAll<HTMLButtonElement>(".calendar-day")];
    const wanted = `${to.year}-${String(to.month).padStart(2, "0")}-${String(to.day).padStart(2, "0")}`;
    for (const button of buttons) button.tabIndex = button.dataset.date === wanted ? 0 : -1;
    buttons.find((button) => button.dataset.date === wanted)?.focus();
  }

  private render(): void {
    const { year, month } = this.view;
    const today = this.now();
    const marked = new Set(this.host.daysWithPages(year, month));
    const title = `${MONTHS[month - 1]} ${year}`;
    const before = neighbourMonth(year, month, -1);
    const after = neighbourMonth(year, month, 1);
    this.title.textContent = title;
    // (the one day that the Tab key stops at: the open page's, else today's, else the first)
    const inView = (date: JournalDay | undefined): number | undefined => (date && date.year === year && date.month === month ? date.day : undefined);
    const stop = inView(this.selected) ?? inView(today) ?? 1;
    const header = h(
      "div",
      { class: "calendar-head" },
      h("button", { type: "button", class: "calendar-step", "aria-label": "Previous month", text: "‹", disabled: before.year === year && before.month === month, on: { click: () => this.go(-1) } }),
      this.title,
      h("button", { type: "button", class: "calendar-step", "aria-label": "Next month", text: "›", disabled: after.year === year && after.month === month, on: { click: () => this.go(1) } }),
    );
    const grid = h("div", { class: "calendar-grid", role: "grid", "aria-label": title });
    grid.append(h("div", { class: "calendar-week calendar-weekdays", role: "row" }, ...WEEKDAYS.map((name) => h("span", { class: "calendar-weekday", role: "columnheader", text: name }))));
    for (const week of monthWeeks(year, month)) {
      grid.append(
        h(
          "div",
          { class: "calendar-week", role: "row" },
          ...week.map((day) => {
            if (day === null) return h("span", { class: "calendar-blank", role: "gridcell" });
            const date = { year, month, day };
            const classes = ["calendar-day"];
            if (marked.has(day)) classes.push("has-page");
            if (sameDay(today, date)) classes.push("today");
            if (sameDay(this.selected, date)) classes.push("selected");
            return h(
              "span",
              { role: "gridcell" },
              h("button", {
                type: "button",
                class: classes.join(" "),
                text: String(day),
                tabindex: day === stop ? "0" : "-1",
                "data-date": `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
                "aria-label": `${day} ${MONTHS[month - 1]} ${year}${marked.has(day) ? ", has a page" : ""}${sameDay(today, date) ? ", today" : ""}`,
                "aria-pressed": sameDay(this.selected, date) ? "true" : "false",
                on: { click: () => this.host.open(date) },
              }),
            );
          }),
        ),
      );
    }
    const footer = h(
      "div",
      { class: "calendar-foot" },
      h("button", { type: "button", class: "calendar-today", text: "Today", on: { click: () => this.host.open(this.now()) } }),
    );
    clear(this.body);
    this.body.append(header, grid, footer);
  }
}
