// What the notebook rules and the format crate offer for tags, journal pages and tables, as TypeScript sees
// them through wasm: the shapes cross the boundary as they should (UTF-16 offsets, no loss), and the
// rules agree with what the browser itself knows (the calendar).
import { readFileSync } from "node:fs";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Extension, TransactionSpec } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, daysInMonth, monthWeeks, neighbourMonth, weekdayOf } from "../src/app/calendar";
import { headingsOf } from "../src/app/contents";
import { applyLink, linkSource, tagAt, zimExtensions } from "../src/editor";
import { NotebookModel, journalDayOf, journalPage, journalPageText, journalTitle } from "../src/notebook-core";
import type { LinkSuggestion } from "../src/notebook-core";
import { tableAddColumn, tableAddRow, tableDeleteColumn, tableDeleteRow, tableFormat, tableLayout, tableNew, tableSetAlign } from "../src/table";
import { initZimSync } from "../src/zim";

beforeAll(() => {
  initZimSync(readFileSync(new URL("../src/zim-wasm/zim_wasm_bg.wasm", import.meta.url)));
});

describe("tags", () => {
  const notebook = (): NotebookModel => {
    const nb = new NotebookModel();
    nb.put("Garden", "Water the tomatoes @urgent and @home.\n");
    nb.put("Roof", "Fix the roof @Urgent, @roof.\n");
    nb.put("Heading", "====== @urgent ======\n");
    return nb;
  };

  it("are listed with their pages, by name with case ignored", () => {
    const nb = notebook();
    expect(nb.tags()).toEqual([
      { name: "home", pages: ["Garden"] },
      { name: "roof", pages: ["Roof"] },
      { name: "urgent", pages: ["Garden", "Roof"] },
    ]);
    expect(nb.pagesWithTag("@URGENT")).toEqual(["Garden", "Roof"]);
    expect(nb.pagesWithTag("nothing")).toEqual([]);
    expect(nb.tagsOf("Roof")).toEqual(["Urgent", "roof"]);
    expect(nb.tagsOf("No such page")).toEqual([]);
    nb.free();
  });

  it("are searched for with an @, exactly, together with words", () => {
    const nb = notebook();
    expect(nb.search("@urgent", 10).map((h) => h.page)).toEqual(["Garden", "Roof"]);
    expect(nb.search("@urgent tomatoes", 10).map((h) => h.page)).toEqual(["Garden"]);
    expect(nb.search("@urg", 10)).toEqual([]);
    expect(nb.search("@home", 10)[0]?.snippet).toContain("@home");
    nb.free();
  });
});

describe("the journal", () => {
  it("names the page of a day and says which day a page is", () => {
    expect(journalPage({ year: 2026, month: 10, day: 9 })).toBe("Journal:2026:10:09");
    expect(journalPage({ year: 2026, month: 2, day: 30 })).toBeUndefined();
    expect(journalPage({ year: 2023, month: 2, day: 29 })).toBeUndefined();
    expect(journalDayOf("Journal:2026:10:09")).toEqual({ year: 2026, month: 10, day: 9 });
    expect(journalDayOf("journal:2026:10:09")).toEqual({ year: 2026, month: 10, day: 9 });
    for (const other of ["Journal:2026:1:9", "Journal:2026:10", "Journal:2026:10:09:Notes", "Notes", "Journal:2026:02:30"]) {
      expect(journalDayOf(other), other).toBeUndefined();
    }
    expect(journalDayOf("not a valid name?")).toBeUndefined();
  });

  it("agrees with the browser's calendar about every weekday of two centuries", () => {
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let days = 0;
    for (let time = Date.UTC(1900, 0, 1); time <= Date.UTC(2100, 11, 31); time += 86_400_000) {
      const date = new Date(time);
      const day = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
      const expected = `${weekdays[date.getUTCDay()]} ${String(day.day).padStart(2, "0")} ${months[date.getUTCMonth()]} ${day.year}`;
      if (journalTitle(day) !== expected) throw new Error(`${JSON.stringify(day)}: ${journalTitle(day)} is not ${expected}`);
      days++;
    }
    expect(days).toBe(73_414);
    // and a day that is not one has no title
    expect(journalTitle({ year: 2026, month: 2, day: 29 })).toBeUndefined();
  });

  it("starts a day's page with the header and the day as its title", () => {
    expect(journalPageText({ year: 2026, month: 10, day: 9 }, "2026-10-09T08:15:00+02:00")).toBe(
      "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-09T08:15:00+02:00\n\n====== Friday 09 October 2026 ======\n",
    );
    expect(journalPageText({ year: 2026, month: 13, day: 1 }, "x")).toBeUndefined();
  });

  it("knows which days of a month have a page", () => {
    const nb = new NotebookModel();
    for (const page of ["Journal:2026:10:09", "Journal:2026:10:03", "Journal:2026:10:03:Notes", "Journal:2026:09:30", "Journal:2026:10"]) nb.put(page, "text\n");
    expect(nb.journalDays(2026, 10)).toEqual([3, 9]);
    expect(nb.journalDays(2026, 9)).toEqual([30]);
    expect(nb.journalDays(2026, 11)).toEqual([]);
    nb.free();
  });
});

describe("tables", () => {
  const table = "| Name | Count |\n|:-----|------:|\n| café | 3 |\n| 😀 | 12 |";

  it("are read with the place of every cell, in the units of a JavaScript string", () => {
    const layout = tableLayout(table);
    expect(layout).toBeDefined();
    expect(layout).toMatchObject({ columns: 2, alignLine: 1, aligns: ["left", "right"], wraps: [false, false] });
    expect(layout?.rows.map((r) => r.line)).toEqual([0, 2, 3]);
    // every cell is where its text is, whatever came before it (an emoji is two units of a string)
    for (const row of layout?.rows ?? []) {
      expect(table.slice(row.start, row.end).startsWith("|")).toBe(true);
      for (const cell of row.cells) expect(table.slice(cell.start, cell.end).trim()).toBe(cell.raw);
    }
    expect(layout?.rows[2]?.cells.map((c) => c.raw)).toEqual(["😀", "12"]);
  });

  it("are not read from what is not one", () => {
    for (const text of ["", "plain text", "| a |", "| a |\n|---|", "| a |\nnot a row\n| b |"]) expect(tableLayout(text), text).toBeUndefined();
  });

  it("are laid out, extended and cut by the rules of the format crate", () => {
    expect(tableFormat("|a|b|\n|c|d|")).toBe("| a   | b   |\n| c   | d   |");
    expect(tableAddRow("|a|b|\n|c|d|", 0)).toBe("| a   | b   |\n|     |     |\n| c   | d   |");
    expect(tableDeleteRow("|a|b|\n|c|d|\n|e|f|", 1)).toBe("| a   | b   |\n| e   | f   |");
    expect(tableDeleteRow("|a|b|\n|c|d|", 1)).toBeUndefined();
    expect(tableAddColumn("|a|b|\n|c|d|", 0)).toBe("| a   | Header 2 | b   |\n| c   |          | d   |");
    expect(tableDeleteColumn("|a|b|\n|c|d|", 0)).toBe("| b   |\n| d   |");
    expect(tableDeleteColumn("|a|\n|c|", 0)).toBeUndefined();
    expect(tableSetAlign("|a|b|\n|c|d|", 1, "right")).toBe("| a   |   b |\n|-----|----:|\n| c   |   d |");
    expect(tableFormat("not a table")).toBeUndefined();
    expect(tableSetAlign("|a|b|\n|c|d|", 9, "right")).toBeUndefined();
  });

  it("start as a table, with a header, an alignment row and empty rows", () => {
    const text = tableNew(3, 2);
    expect(text.split("\n")).toHaveLength(4);
    expect(tableLayout(text)).toMatchObject({ columns: 3, alignLine: 1 });
    expect(tableNew(0, 0).split("\n").length).toBe(3);
  });
});

describe("the contents of a page", () => {
  const headings = (text: string) => headingsOf(EditorState.create({ doc: text, extensions: zimExtensions() }));

  it("are its headings, in order, with their level and where each starts", () => {
    const text = [
      "Content-Type: text/x-zim-wiki",
      "Wiki-Format: zim 0.6",
      "",
      "====== Title ======",
      "Some text.",
      "",
      "===== Second =====",
      "==== Third ====",
      "=== Fourth ===",
      "== Fifth ==",
      "",
    ].join("\n");
    const found = headings(text);
    expect(found.map((h) => [h.level, h.text])).toEqual([[1, "Title"], [2, "Second"], [3, "Third"], [4, "Fourth"], [5, "Fifth"]]);
    for (const heading of found) expect(text.slice(heading.from, heading.from + 2)).toBe("==");
    expect(text.slice(found[1]!.from).startsWith("===== Second")).toBe(true);
  });

  it("say what a person reads: the markup in a heading is not part of it", () => {
    const found = headings("====== The **bold** and //italic// [[Page|display]] and [[Other]] ======\n");
    expect(found.map((h) => h.text)).toEqual(["The bold and italic display and Other"]);
  });

  it("say what a person reads: an anchor in a heading is a place to link to, not a word of the title", () => {
    expect(headings("====== Title {{id: my-anchor}} ======\n=== {{id: first}}Start ===\n").map((h) => h.text)).toEqual(["Title", "Start"]);
  });

  it("say what a person reads: a run of blanks is one space, and the heading's own edges are not part of it", () => {
    expect(headings("======   A   spaced \t title   ======\n").map((h) => h.text)).toEqual(["A spaced title"]);
  });

  it("do not include lines that only look like headings", () => {
    const found = headings("text\n\n'''\n====== In code ======\n'''\n\n| ====== in a table ====== |\n|---|\n\n====== Real ======\n");
    expect(found.map((h) => h.text)).toEqual(["Real"]);
  });

  it("are none for a page without headings, and are found on a page of one line", () => {
    expect(headings("")).toEqual([]);
    expect(headings("just text\n")).toEqual([]);
    expect(headings("== Only ==").map((h) => h.text)).toEqual(["Only"]);
  });
});

describe("the calendar", () => {
  it("knows the length of every month, by the browser's own dates", () => {
    for (const year of [1900, 2000, 2023, 2024, 2100]) {
      for (let month = 1; month <= 12; month++) {
        expect(daysInMonth(year, month), `${year}-${month}`).toBe(new Date(Date.UTC(year, month, 0)).getUTCDate());
      }
    }
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
  });

  it("has the first hundred years right too, which the browser's Date.UTC would put in the 1900s", () => {
    expect([daysInMonth(4, 2), daysInMonth(50, 2), daysInMonth(100, 2), daysInMonth(400, 2)]).toEqual([29, 28, 28, 29]);
    const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    // (the notebook's own rule for the weekday, in Rust, is the other side of the check)
    for (const year of [1, 4, 33, 50, 99, 100, 400, 1000, 1600, 2000, 9999]) {
      for (let month = 1; month <= 12; month++) {
        for (const day of [1, 15, daysInMonth(year, month)]) {
          expect(names[weekdayOf(year, month, day)], `${year}-${month}-${day}`).toBe(journalTitle({ year, month, day })!.split(" ")[0]);
        }
      }
    }
    // and the grid puts each day under its weekday
    const weeks = monthWeeks(50, 1);
    expect(weeks[0]!.indexOf(1)).toBe(weekdayOf(50, 1, 1));
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(31);
  });

  it("moves by days across months, years and leap days, and stays where it is at the ends of the calendar", () => {
    expect(addDays({ year: 2026, month: 10, day: 31 }, 1)).toEqual({ year: 2026, month: 11, day: 1 });
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({ year: 2025, month: 12, day: 31 });
    expect(addDays({ year: 2024, month: 2, day: 28 }, 1)).toEqual({ year: 2024, month: 2, day: 29 });
    expect(addDays({ year: 2023, month: 2, day: 28 }, 1)).toEqual({ year: 2023, month: 3, day: 1 });
    expect(addDays({ year: 2026, month: 10, day: 9 }, -7)).toEqual({ year: 2026, month: 10, day: 2 });
    expect(addDays({ year: 2026, month: 10, day: 9 }, 7 * 4)).toEqual({ year: 2026, month: 11, day: 6 });
    expect(addDays({ year: 9999, month: 12, day: 31 }, 1)).toEqual({ year: 9999, month: 12, day: 31 });
    expect(addDays({ year: 1, month: 1, day: 1 }, -1)).toEqual({ year: 1, month: 1, day: 1 });
    expect(addDays({ year: 50, month: 3, day: 1 }, -1)).toEqual({ year: 50, month: 2, day: 28 });
  });

  it("lays a month out in weeks that start on Monday", () => {
    // October 2026 starts on a Thursday and ends on a Saturday
    const weeks = monthWeeks(2026, 10);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(weeks[4]).toEqual([26, 27, 28, 29, 30, 31, null]);
    // a month that starts on a Monday has no blanks before it, and one of four whole weeks has four rows (February 2021)
    expect(monthWeeks(2021, 2)).toEqual([
      [1, 2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11, 12, 13, 14],
      [15, 16, 17, 18, 19, 20, 21],
      [22, 23, 24, 25, 26, 27, 28],
    ]);
    // a month that starts on a Sunday needs six rows when it is long (May 2022: 31 days from a Sunday)
    expect(monthWeeks(2022, 5)).toHaveLength(6);
    expect(monthWeeks(2022, 5)[0]).toEqual([null, null, null, null, null, null, 1]);
  });

  it("holds every day of a month once, in order, whatever the month is", () => {
    for (let year = 1999; year <= 2001; year++) {
      for (let month = 1; month <= 12; month++) {
        const weeks = monthWeeks(year, month);
        const days = weeks.flat().filter((d): d is number => d !== null);
        expect(days, `${year}-${month}`).toEqual(Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1));
        expect(weeks.every((week) => week.length === 7)).toBe(true);
        // and each day is under its weekday (Monday first)
        weeks.forEach((week) =>
          week.forEach((day, column) => {
            if (day !== null) expect((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7, `${year}-${month}-${day}`).toBe(column);
          }),
        );
      }
    }
  });

  it("goes to the month before and after, across years, and stops at the ends of the calendar", () => {
    expect(neighbourMonth(2026, 10, 1)).toEqual({ year: 2026, month: 11 });
    expect(neighbourMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(neighbourMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(neighbourMonth(2026, 3, -1)).toEqual({ year: 2026, month: 2 });
    expect(neighbourMonth(1, 1, -1)).toEqual({ year: 1, month: 1 });
    expect(neighbourMonth(9999, 12, 1)).toEqual({ year: 9999, month: 12 });
    expect(neighbourMonth(9999, 11, 1)).toEqual({ year: 9999, month: 12 });
  });
});

describe("completing a link", () => {
  const garden: LinkSuggestion = { page: "Projects:Garden", link: "+Garden", exists: true };
  const section: LinkSuggestion = { page: "Projects", link: "Projects", exists: false };
  const asked: string[] = [];
  const suggest = (typed: string): LinkSuggestion[] => {
    asked.push(typed);
    return typed === "none" ? [] : [garden, section];
  };
  /** The text with a ¦ where the caret is. */
  const stateOf = (marked: string, extra: Extension[] = []): EditorState => {
    const at = marked.indexOf("¦");
    return EditorState.create({ doc: marked.replace("¦", ""), selection: EditorSelection.cursor(at), extensions: [zimExtensions(), ...extra] });
  };
  const offer = (marked: string, explicit = false, extra: Extension[] = []) => {
    const state = stateOf(marked, extra);
    const result = linkSource(suggest)(new CompletionContext(state, state.selection.main.head, explicit));
    return { state, result: result as Exclude<typeof result, Promise<unknown>> };
  };

  it("offers what the notebook says for the text after [[, in its order, from where that text starts", () => {
    asked.length = 0;
    const { result } = offer("see [[Gar¦");
    expect(asked).toEqual(["Gar"]);
    expect(result).toMatchObject({ from: 6, to: 9, filter: false });
    expect(result?.options.map((o) => o.label)).toEqual(["Projects:Garden", "Projects"]);
    // what is written for a page is shown when it is not the name, and a section says so
    expect(result?.options.map((o) => o.detail)).toEqual(["[[+Garden]]", "section"]);
    expect(result?.options.map((o) => o.type)).toEqual(["page", "section"]);
  });

  it("is asked for all the text between the brackets and the caret, spaces and colons included", () => {
    asked.length = 0;
    offer("[[Projects: Ga¦");
    offer("[[+gar¦");
    expect(asked).toEqual(["Projects: Ga", "+gar"]);
  });

  it("offers nothing where no link is being typed", () => {
    for (const marked of ["plain text¦", "[[Page]] and then¦", "[[Page]]¦", "[[Page|Dis¦", "[[Page#hea¦", "[[Pa]ge¦", "[¦", "[[\nGar¦", "text [ [Gar¦"]) {
      expect(offer(marked).result, marked).toBeNull();
    }
    // (nor for what the notebook has no answer to)
    expect(offer("[[none¦").result).toBeNull();
  });

  it("waits for a key after a bare [[, unless it is asked", () => {
    expect(offer("[[¦").result).toBeNull();
    expect(offer("[[¦", true).result?.options).toHaveLength(2);
  });

  it("offers nothing in a header, in code, or in a read-only page", () => {
    const header = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: [[Gar¦\n\ntext\n";
    expect(offer(header).result).toBeNull();
    expect(offer("'''\n[[Gar¦\n'''\n").result).toBeNull();
    expect(offer("''in [[Gar¦ code''").result).toBeNull();
    expect(offer("[[Gar¦", false, [EditorState.readOnly.of(true)]).result).toBeNull();
    // but after the code, and in a table cell, a link is typed
    expect(offer("''code'' [[Gar¦").result).not.toBeNull();
    expect(offer("| a | [[Gar¦ |\n|---|---|\n| b | c |").result).not.toBeNull();
  });

  it("replaces the whole target when the caret is in the middle of one", () => {
    const { result } = offer("[[Pa¦ge]] and more");
    expect(result).toMatchObject({ from: 2, to: 6 });
    // (the text after a link that is not closed is not part of it; one with a display part ends at the bar)
    expect(offer("[[Pa¦ge and more").result).toMatchObject({ from: 2, to: 4 });
    expect(offer("[[Pa¦ge|shown]]").result).toMatchObject({ from: 2, to: 6 });
    expect(offer("[[Pa¦ge#head]]").result).toMatchObject({ from: 2, to: 6 });
  });

  describe("writing the page", () => {
    /** Choose `link` in `marked` (the caret where the typed text ends), and show the result with a ¦ after it. */
    const choose = (marked: string, link = "+Garden"): string => {
      let state = stateOf(marked);
      const { result } = offer(marked);
      const view = {
        get state() {
          return state;
        },
        dispatch(spec: TransactionSpec) {
          state = state.update(spec).state;
        },
      };
      applyLink(view, result!.from, result!.to!, link);
      const caret = state.selection.main.head;
      const doc = state.doc.toString();
      return `${doc.slice(0, caret)}¦${doc.slice(caret)}`;
    };

    it("closes the brackets, and puts the caret after them", () => {
      expect(choose("see [[Gar¦")).toBe("see [[+Garden]]¦");
      expect(choose("see [[Gar¦ and more")).toBe("see [[+Garden]]¦ and more");
    });

    it("takes the brackets that are there for its own", () => {
      expect(choose("[[Gar¦]]")).toBe("[[+Garden]]¦");
      expect(choose("[[Gar¦]] and [[Other]]")).toBe("[[+Garden]]¦ and [[Other]]");
      expect(choose("[[Gar¦]")).toBe("[[+Garden]]¦");
      expect(choose("[[Pa¦ge]] and")).toBe("[[+Garden]]¦ and");
      expect(choose("[[Pa¦ge and more")).toBe("[[+Garden]]¦ge and more");
    });

    it("is one change that can be undone as a whole, and the text is exactly what was written", () => {
      expect(choose("[[Gar¦", "Projects:Garden")).toBe("[[Projects:Garden]]¦");
      expect(choose("[[Gar¦", "Ünï cödé")).toBe("[[Ünï cödé]]¦");
    });
  });
});

describe("tags in the text", () => {
  const stateOf = (text: string): EditorState => EditorState.create({ doc: text, extensions: [zimExtensions()] });

  it("are found where the caret touches them, with their name", () => {
    const state = stateOf("Water the plants @home and @Garden_2 today. user@example.org\n");
    const at = (needle: string, offset = 0) => state.doc.toString().indexOf(needle) + offset;
    expect(tagAt(state, at("@home"))?.name).toBe("home");
    expect(tagAt(state, at("@home", 3))?.name).toBe("home");
    expect(tagAt(state, at("@home", 5))?.name).toBe("home");
    expect(tagAt(state, at("@Garden_2", 4))).toMatchObject({ name: "Garden_2", from: at("@Garden_2"), to: at("@Garden_2") + 9 });
    // not elsewhere, and an address is not a tag
    expect(tagAt(state, at("Water"))).toBeNull();
    expect(tagAt(state, at("today"))).toBeNull();
    expect(tagAt(state, at("@example", 2))).toBeNull();
  });
});
