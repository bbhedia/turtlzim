// A notebook to look at: sections and sub-pages, every kind of link with a live example, a page
// that doesn't exist yet (so its link looks different), tasks, tags, a table, a day of the journal,
// and a place to link to.
// Written for this demo. Names and links are checked by test/session.test.ts.
import type { NotebookStore, NotebookInfo, StoredPage } from "./store";

const HEADER = "Content-Type: text/x-zim-wiki\nWiki-Format: zim 0.6\nCreation-Date: 2026-10-06T09:00:00+00:00\n\n";

export const SAMPLE_PAGES: Array<{ name: string; text: string }> = [
  {
    name: "Home",
    text: HEADER + `====== Welcome ======

This is a **notebook**: pages that link to each other, written in the Zim wiki format. Everything you see is plain text underneath; put the cursor in a word, or press //Show markup//, and the characters come back.

===== Where to start =====

* [[Help:Editor]]: formatting and keyboard shortcuts
* [[Help:Links]]: how a link finds its page
* [[Help:Tables]], [[Help:Journal]] and [[Help:Tags]]
* [[Projects]]: a section with pages below it
* [[Journal:2026:10:06|A day of the journal]]
* [[Ideas]]: one of its links goes to a page that doesn't exist yet

===== Try this =====

[ ] Open [[Projects:Garden]] and tick a task
[ ] Rename a page (the Rename button above it) and watch the links to it follow
[ ] Follow a link to a page that doesn't exist, and start writing there
[ ] Search for a word, then look at the backlinks of the page you land on
`,
  },
  {
    name: "Help:Editor",
    text: HEADER + `====== The editor ======

**Bold** is Ctrl+B, //italic// Ctrl+I, __underline__ Ctrl+U, and ~~strikethrough~~ Ctrl+Shift+X. ''Code'' is Ctrl+E.

Headings are Ctrl+Alt+1 to 5, and Ctrl+Alt+0 makes a heading plain text again. Ctrl+K makes a link.

===== Lists =====

* Enter continues a list; Enter on an empty item goes out a level
* Tab nests an item, Shift+Tab brings it back
	* like this one
1. Numbers count up
2. as you go
[ ] Ctrl+Enter ticks a box
[*] this one is done

===== Finding your way =====

Type ''[['' and a few letters of a page's name: the pages that fit are offered, the best first, and Enter writes the link (the shortest one that leads there from this page). The //Contents// list on the left shows the headings of the page you are on; click one to go to it. A word that starts with an at sign is a tag: see [[Help:Tags]].

===== Code =====

'''
Anything between three quotes is left exactly as written: **not bold**, [[not a link]].
'''

Back to [[Home]], or see how [[Help:Links]] work.
`,
  },
  {
    name: "Help:Links",
    text: HEADER + `====== Links ======

A link is the name of a page in double brackets. What the name means depends on how it starts, and on where the link is written.

===== A plain name =====

A name like [[Editor]] is looked up beside this page (in the section ''Help''), then beside each section above it. That is how it finds [[Help:Editor]] from here. A name that isn't found in any of those places leads to a new page beside this one. To reach a page deeper in the tree, give the way in: [[Projects:Garden]] works because ''Projects'' is found at the top, and the rest follows it.

===== From the top, or below this page =====

* [[:Home]] starts with a colon, so it is looked up from the top of the notebook
* [[+Examples]] starts with a plus: it is a page //below// this one
* [[#a-place-on-this-page|A link to a heading on this page]]

===== A place on this page =====

Every heading is a place a link can lead to: its id is the heading in lower case with dashes for spaces, so this one is ''a-place-on-this-page''. Other pages can link to it with [[Help:Links#a-place-on-this-page]].

===== Pages that don't exist yet =====

[[Not written yet]] leads to a page that doesn't exist. The link is drawn differently, and following it starts the page.
`,
  },
  {
    name: "Help:Links:Examples",
    text: HEADER + `====== Link examples ======

This page is below [[Help:Links]], so from here:

* [[Editor]] is found beside [[Help:Links]], in ''Help'': it leads to [[Help:Editor]]
* [[Links]] is this page's own parent
* [[Projects:Garden:Plan]] starts in a section found at the top
* [[:Home]] is the front page
`,
  },
  {
    name: "Help:Tables",
    text: HEADER + `====== Tables ======

A table is a block of lines that start and end with a bar. The first line is the header; the dashes below it say how each column is lined up ('':--'' left, '':-:'' centred, ''--:'' right), and every line after that is a row:

| Fruit | In stock | Notes |
|:------|---------:|:-----:|
| **apples** | 12 | from the [[Projects:Garden\\|garden]] |
| pears | 3 | //ripe// |
| plums | 0 | sold out |

While the caret is somewhere else the table is drawn as a grid, with its cells formatted. Put the caret in it (click a cell) and it turns into the lines it is written as, with a row of buttons over it.

===== Writing in a table =====

* **Tab** goes to the next cell and **Shift+Tab** back; Tab in the last cell makes a new row
* **Enter** goes to the cell below, and makes a row below the last; on an empty last row it ends the table
* **Shift+Enter** breaks the line inside a cell (it is written ''\\n'')
* The buttons add or delete a row or a column, line a column up on the left, in the middle or on the right, and **Tidy** writes the lines out again with the bars under each other (Alt+F10 goes to them from the keyboard)
* The **Table** button above the page makes a new table where the caret is

===== In the text =====

A bar that is part of what a cell says is written ''\\|''. A header that ends with ''<'' marks a column whose cells wrap, instead of staying on one line. Nothing is changed in a table until you change it: the lines are kept as they were written.

Back to [[Help:Editor]].
`,
  },
  {
    name: "Help:Journal",
    text: HEADER + `====== The journal ======

The calendar on the left has a page for every day. A day's page is called //Journal:Year:Month:Day//, like [[:Journal:2026:10:06|Journal:2026:10:06]]; the days that have one are in bold with a dot. Click a day to open its page: it is made when you write something in it, and starts with the day as its title. **Today** (and //Today's journal// in the notebook menu) opens today's.

Pages below a day, like //Journal:2026:10:06:Notes//, belong to it but are not the day. A name with a month that is not one, or a day that is not, is just a page.

Back to [[Home]].
`,
  },
  {
    name: "Help:Tags",
    text: HEADER + `====== Tags ======

A word that starts with an at sign is a tag: @garden is one, and so is @journal. Tags are not found in headings, code, tables or the lines at the top of a page, and case does not matter.

* The //Tags// list on the left has every tag with the number of pages that write it; click one to see them
* Ctrl-click a tag in a page does the same
* In the search box, **@garden** finds the pages with that tag exactly, and words next to it narrow them down: **@garden beans**

See [[Projects:Garden]] and [[:Journal:2026:10:06|Journal:2026:10:06]] for pages that have them.
`,
  },
  {
    name: "Projects",
    text: HEADER + `====== Projects ======

Pages below this one are the projects. The tree on the left shows them.

* [[+Garden]]: the vegetable patch
* [[+Reading List]]: books, in order
`,
  },
  {
    name: "Projects:Garden",
    text: HEADER + `====== Garden ======

===== This season =====

[*] Order seeds
[*] Clear the beds
[ ] Plant the beans
[ ] Build a frame for the peas
	[ ] Buy 2.4m timber
	[ ] Saw it to length
[x] Move the greenhouse (not this year)

See the [[+Plan|plan]] for where things go, and [[Journal:2026:10:06]] for what happened that day. @garden @spring
`,
  },
  {
    name: "Projects:Garden:Plan",
    text: HEADER + `====== Plan ======

Beds run north to south, 1.2 m wide.

===== Bed 1 =====

Beans along the back, with peas on the frame ([[Garden]] has the tasks).

===== Bed 2 =====

Roots: carrots and beetroot, sown in drills 30 cm apart.

Back to [[Projects]].
`,
  },
  {
    name: "Projects:Reading List",
    text: HEADER + `====== Reading List ======

1. A book about soil
2. A book about bees
3. [[Ideas|The ideas page]] has more
`,
  },
  {
    name: "Journal:2026:10:06",
    text: HEADER + `====== Tuesday 06 October 2026 ======

Morning: cleared the beds ([[Projects:Garden]]). Wrote down some thoughts in [[Ideas]].

Evening: tried the notebook editor. @journal
`,
  },
  {
    name: "Ideas",
    text: HEADER + `====== Ideas ======

* A compost bin by the fence
* A rain barrel, once the gutters are fixed
* Something about [[Beekeeping]], which has no page yet
* See [[Projects:Reading List]]
`,
  },
];

/** The sample notebook, as a notebook in `store`. */
export async function createSampleNotebook(store: NotebookStore, title = "Sample notebook", kind: NotebookInfo["kind"] = "open", location?: string): Promise<NotebookInfo> {
  const now = Date.now();
  const pages: StoredPage[] = SAMPLE_PAGES.map((p) => ({ ...p, bom: false, lineEnding: "lf", modified: now }));
  return store.createNotebook({ title, home: "Home", kind, ...(location ? { location } : {}) }, pages);
}
