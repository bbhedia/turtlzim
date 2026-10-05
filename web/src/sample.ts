// A page that shows what the editor does. Written for this demo; it uses every construct the
// format has so a glance at the page shows what each looks like with its markup hidden.
export const SAMPLE = `Content-Type: text/x-zim-wiki
Wiki-Format: zim 0.6
Creation-Date: 2026-10-05T09:00:00+00:00

====== Welcome to the Zim editor ======

This page is plain text in the **Zim wiki format**. What you see is that text with its markup tidied away: put the cursor in a word, or turn on //Show markup//, and the characters come back. Nothing is ever rewritten behind your back, so saving gives you exactly the bytes you opened.

===== Text styles =====

**Bold**, //italic//, __underline__, ~~strikethrough~~ and ''verbatim''. They nest: **bold with //italic// inside**. Chemistry gets H_{2}O and maths gets x^{2}.

===== Links and tags =====

Link to a [[Projects:Garden|page in the notebook]] or to [[Inbox]], jump to [[#lists|a place on this page]], visit https://zim-wiki.org, or write to someone@example.org. Hold Ctrl (or Cmd) and click a link to follow it. Tags look like @idea or @todo.

An image is a chip until you go inside it: {{./pictures/garden.png?width=300|The garden in spring}}. Anchors are small too: {{id: lists}}

===== Lists =====

* A bullet
* Another bullet
	* nested one level
		* and two

1. Numbered
2. also numbered
	a. with letters inside

[ ] A task that is open
[*] A task that is done
[x] One that was dropped
	[ ] a sub-task

===== Code and rules =====

'''
fn main() {
    println!("**not bold** and //not italic// in here");
}
'''

--------------------

	An indented paragraph: it keeps its tab, which is how
	Zim writes a quotation.

| Tables | stay as they are |
|--------|------------------|
| for now | (shown raw) |
`;
