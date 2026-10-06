//! Files in a notebook: attachments, how a page's references to them are read, and what a rename
//! does to them. (The property test that renames random notebooks full of references is in
//! `notebook.rs`; the real notebooks are in `golden_notebooks.rs`.)

mod common;
use common::{name, Rng};
use zim_notebook::{
    check_file_path, classify, images_in, relative_file_text, safe_file_name, unique_file_name,
    FileTarget, LinkKind, Notebook, PageName, RenameError,
};

fn with_files(files: &[&str]) -> Notebook {
    let mut nb = Notebook::new();
    for f in files {
        nb.put_file(f).unwrap_or_else(|e| panic!("{e}"));
    }
    nb
}

fn found(path: &str) -> FileTarget {
    FileTarget::Notebook {
        path: path.into(),
        exists: true,
    }
}

fn missing(path: &str) -> FileTarget {
    FileTarget::Notebook {
        path: path.into(),
        exists: false,
    }
}

// ---- where a reference leads

#[test]
fn a_reference_is_relative_to_the_folder_named_like_the_page() {
    let nb = with_files(&[
        "Usage/GTD_flowchart.png",
        "Plugins/Table_Editor/table_demo.png",
        "Plugins/Table_Editor/Basic_Table_Operations/insert-table.png",
        "top.png",
        "Foo/a.png",
    ]);
    let leads = |from: &str, target: &str| nb.resolve_file(&name(from), target);
    // the manual's own examples: `{{../GTD_flowchart.png}}` on `Usage:Getting Things Done`
    assert_eq!(
        leads("Usage:Getting Things Done", "../GTD_flowchart.png"),
        found("Usage/GTD_flowchart.png")
    );
    assert_eq!(
        leads("Plugins:Table Editor", "./table_demo.png"),
        found("Plugins/Table_Editor/table_demo.png")
    );
    assert_eq!(
        leads(
            "Plugins:Table Editor:Basic Table Operations",
            "./insert-table.png"
        ),
        found("Plugins/Table_Editor/Basic_Table_Operations/insert-table.png")
    );
    // a name with no `./` is in the folder too, and a path may go down into a folder or up out of one
    assert_eq!(
        leads("Plugins:Table Editor", "table_demo.png"),
        found("Plugins/Table_Editor/table_demo.png")
    );
    assert_eq!(
        leads(
            "Plugins:Table Editor",
            "./Basic_Table_Operations/insert-table.png"
        ),
        found("Plugins/Table_Editor/Basic_Table_Operations/insert-table.png")
    );
    assert_eq!(
        leads(
            "Plugins:Table Editor:Basic Table Operations",
            "../table_demo.png"
        ),
        found("Plugins/Table_Editor/table_demo.png")
    );
    // above the top page's folder is the top of the notebook; above that is nothing
    assert_eq!(leads("Foo", "../top.png"), found("top.png"));
    assert_eq!(leads("Foo", "../../top.png"), FileTarget::Outside);
    // a file that isn't there is still a place: where it would be
    assert_eq!(leads("Usage", "./nope.png"), missing("Usage/nope.png"));
    // `.` parts, empty parts and backslashes (Windows tools write them) change nothing
    assert_eq!(leads("Foo", "././a.png"), found("Foo/a.png"));
    assert_eq!(leads("Foo", ".//a.png"), found("Foo/a.png"));
    assert_eq!(leads("Foo", ".\\a.png"), found("Foo/a.png"));
    assert_eq!(leads("Foo", "  ./a.png  "), found("Foo/a.png"));
    // names compare without regard to case, and the notebook's spelling comes back
    assert_eq!(leads("foo", "./A.PNG"), found("Foo/a.png"));
}

#[test]
fn a_page_with_spaces_in_its_name_keeps_its_files_in_a_folder_with_underscores() {
    let nb = with_files(&["Help/Auto_Formatting/a.png"]);
    assert_eq!(
        nb.resolve_file(&name("Help:Auto Formatting"), "./a.png"),
        found("Help/Auto_Formatting/a.png")
    );
}

#[test]
fn paths_that_are_not_in_the_notebook_are_outside_it() {
    let nb = with_files(&["Foo/a.png"]);
    for target in [
        "/etc/hosts",
        "~/notes.txt",
        "~",
        "C:\\Users\\me\\a.png",
        "c:/a.png",
        "\\\\host\\share\\a.png",
        "https://example.org/a.png",
        "file:///tmp/a.png",
        "smb://host/share/a.png",
        "",
        "   ",
    ] {
        assert_eq!(
            nb.resolve_file(&name("Foo"), target),
            FileTarget::Outside,
            "{target:?}"
        );
    }
}

#[test]
fn escapes_are_decoded_when_the_path_as_written_is_not_there() {
    let nb = with_files(&["Foo/my file.png", "Foo/50%.png", "Foo/caf\u{e9}.png"]);
    let leads = |t: &str| nb.resolve_file(&name("Foo"), t);
    assert_eq!(leads("./my%20file.png"), found("Foo/my file.png"));
    assert_eq!(leads("./caf%C3%A9.png"), found("Foo/caf\u{e9}.png"));
    assert_eq!(
        leads("./50%.png"),
        found("Foo/50%.png"),
        "a file with a % in its name is found as written"
    );
    assert_eq!(leads("./50%25.png"), found("Foo/50%.png"));
    // an escape that isn't valid UTF-8, or isn't an escape, is left alone
    assert_eq!(leads("./%ff.png"), missing("Foo/%ff.png"));
    assert_eq!(leads("./%zz.png"), missing("Foo/%zz.png"));
    assert_eq!(leads("./100%"), missing("Foo/100%"));
}

// ---- writing a reference

#[test]
fn a_reference_is_written_as_dot_slash_for_the_folder_and_dot_dot_for_above_it() {
    let text = |from: &str, path: &str, dot: bool| relative_file_text(&name(from), path, dot);
    assert_eq!(
        text("Usage:Getting Things Done", "Usage/GTD_flowchart.png", true),
        "../GTD_flowchart.png"
    );
    assert_eq!(text("Foo", "Foo/a.png", true), "./a.png");
    assert_eq!(text("Foo", "Foo/a.png", false), "a.png");
    assert_eq!(text("Foo:Bar", "x.png", true), "../../x.png");
    assert_eq!(text("Foo:Bar", "Foo/Bar/pics/p.png", true), "./pics/p.png");
    assert_eq!(text("Foo:Bar", "Foo/Other/q.png", true), "../Other/q.png");
    assert_eq!(
        text("Foo:Bar", "FOO/bar/q.png", true),
        "./q.png",
        "the folders match without regard to case"
    );
    assert_eq!(
        text("Help:Auto Formatting", "Help/Auto_Formatting/a.png", true),
        "./a.png"
    );
}

#[test]
fn what_is_written_for_a_file_leads_to_it() {
    let mut rng = Rng(0x00F1_1E5C_0FFE_E001);
    let parts = ["a", "b", "c", "a b"];
    for case in 0..5_000 {
        let page = {
            let depth = 1 + rng.below(4);
            PageName::parse(
                &(0..depth)
                    .map(|_| parts[rng.below(parts.len())])
                    .collect::<Vec<_>>()
                    .join(":"),
            )
            .unwrap()
        };
        let mut nb = Notebook::new();
        let depth = 1 + rng.below(5);
        let folders: Vec<String> = (0..depth - 1)
            .map(|_| parts[rng.below(parts.len())].replace(' ', "_"))
            .collect();
        let path = if folders.is_empty() {
            "f.png".to_string()
        } else {
            format!("{}/f.png", folders.join("/"))
        };
        nb.put_file(&path).unwrap();
        for dot in [true, false] {
            let text = relative_file_text(&page, &path, dot);
            assert_eq!(
                nb.resolve_file(&page, &text),
                found(&path),
                "case {case}: {page} -> {path} written as {text:?}"
            );
        }
    }
}

// ---- names for attachments, and paths that can't be files

#[test]
fn an_attachment_is_named_so_that_it_can_be_written_in_a_link_and_never_clashes() {
    assert_eq!(safe_file_name("photo.png"), "photo.png");
    assert_eq!(safe_file_name("My Holiday (1).JPG"), "My Holiday (1).JPG");
    assert_eq!(
        safe_file_name("C:\\Users\\me\\a b.png"),
        "a b.png",
        "only the last part of a path is kept"
    );
    assert_eq!(
        safe_file_name("what? [ok] {fine} #1 | 50% <a>:*\".png"),
        "what_ _ok_ _fine_ _1 _ 50_ _a____.png"
    );
    assert_eq!(safe_file_name(".hidden"), "hidden");
    assert_eq!(safe_file_name("  . trailing. "), "trailing");
    assert_eq!(safe_file_name(""), "file");
    assert_eq!(safe_file_name("..."), "file");
    assert_eq!(safe_file_name("a\tb\nc.txt"), "a_b_c.txt.text");
    let long = format!("{}.png", "x".repeat(300));
    let short = safe_file_name(&long);
    assert!(short.len() <= 120 && short.ends_with(".png"), "{short}");
    let long_unicode = format!("{}.png", "\u{e9}".repeat(200));
    let short = safe_file_name(&long_unicode);
    assert!(
        short.len() <= 120 && short.ends_with(".png") && short.is_char_boundary(short.len() - 4),
        "{short}"
    );
    // and what comes out is always acceptable as the last part of a path
    for wanted in [
        "a",
        ".",
        "..",
        "/",
        "x/../..",
        "\u{0}",
        "a|b",
        "\u{1f600}.png",
    ] {
        let name = safe_file_name(wanted);
        check_file_path(&format!("Foo/{name}"))
            .unwrap_or_else(|e| panic!("{wanted:?} -> {name:?}: {e}"));
    }

    let taken = |n: &str| ["a.png", "a 2.png", "b"].contains(&n);
    assert_eq!(unique_file_name("c.png", taken), "c.png");
    assert_eq!(unique_file_name("a.png", taken), "a 3.png");
    assert_eq!(unique_file_name("b", taken), "b 2");
    assert_eq!(
        unique_file_name(".x", |n| n == ".x"),
        ".x 2",
        "a leading dot is not an extension"
    );

    let mut nb = with_files(&["Foo/Bar/a.png"]);
    let page = name("Foo:Bar");
    assert_eq!(
        nb.attachment_path(&page, "a.png").unwrap(),
        "Foo/Bar/a 2.png"
    );
    assert_eq!(
        nb.attachment_path(&page, "A.PNG").unwrap(),
        "Foo/Bar/A 2.PNG",
        "case does not make a name free"
    );
    assert_eq!(
        nb.attachment_path(&page, "dir/new?.png").unwrap(),
        "Foo/Bar/new_.png"
    );
    assert_eq!(
        nb.attachment_path(&name("Help:Auto Formatting"), "x.png")
            .unwrap(),
        "Help/Auto_Formatting/x.png"
    );
    nb.put_file("Foo/Bar/a 2.png").unwrap();
    assert_eq!(
        nb.attachment_path(&page, "a.png").unwrap(),
        "Foo/Bar/a 3.png"
    );
    assert_eq!(nb.file_link(&page, "Foo/Bar/a 2.png"), "./a 2.png");
}

#[test]
fn only_a_real_relative_path_can_be_a_file() {
    for good in [
        "a.png",
        "Foo/a.png",
        "Foo/Bar Baz/a b.png",
        "caf\u{e9}/\u{1f600}.png",
        "a..b",
        "a./b",
    ] {
        assert!(check_file_path(good).is_ok(), "{good:?}");
    }
    for bad in [
        "",
        "/a.png",
        "Foo//a.png",
        "Foo/",
        "./a.png",
        "Foo/./a.png",
        "../a.png",
        "Foo/../a.png",
        ".hidden",
        "Foo/.hidden/a.png",
        "Foo\\a.png",
        "a\u{0}b",
        "a\nb",
    ] {
        assert!(check_file_path(bad).is_err(), "{bad:?}");
    }
    assert!(check_file_path(&"x".repeat(256)).is_err());
    assert!(check_file_path(&"x".repeat(255)).is_ok());
    let mut nb = Notebook::new();
    assert!(nb.put_file("../a.png").is_err());
    assert_eq!(nb.file_count(), 0, "a path that was refused is not kept");
}

// ---- the files of a notebook

#[test]
fn a_page_folder_holds_its_attachments_and_the_folders_below_hold_the_rest() {
    let mut nb = with_files(&[
        "Foo/a.png",
        "Foo/B.pdf",
        "Foo/pics/p.png",
        "Foo/Bar/c.png",
        "Foobar/d.png",
        "e.png",
    ]);
    assert_eq!(nb.files_of(&name("Foo")), ["Foo/a.png", "Foo/B.pdf"]);
    assert_eq!(nb.files_of(&name("foo:bar")), ["Foo/Bar/c.png"]);
    assert_eq!(nb.files_of(&name("Foo:pics")), ["Foo/pics/p.png"]);
    assert_eq!(nb.files_of(&name("Nothing")), Vec::<String>::new());
    assert_eq!(
        nb.files_below(&name("Foo")),
        ["Foo/a.png", "Foo/B.pdf", "Foo/Bar/c.png", "Foo/pics/p.png"],
        "Foobar is not below Foo"
    );
    // names compare without regard to case; the first spelling stays
    assert!(nb.has_file("FOO/A.PNG"));
    assert_eq!(nb.file_path("foo/a.png"), Some("Foo/a.png"));
    nb.put_file("foo/A.png").unwrap();
    assert_eq!(nb.file_count(), 6);
    assert_eq!(nb.file_path("foo/a.png"), Some("Foo/a.png"));
    assert!(nb.remove_file("FOO/a.PNG"));
    assert!(!nb.remove_file("Foo/a.png"));
    assert_eq!(
        nb.remove_files_below(&name("Foo")),
        ["Foo/B.pdf", "Foo/Bar/c.png", "Foo/pics/p.png"]
    );
    assert_eq!(nb.files().collect::<Vec<_>>(), ["e.png", "Foobar/d.png"]);
}

// ---- images

#[test]
fn images_are_found_with_their_parts() {
    let text = "a {{./a.png}} b {{./h.png?height=50}} c {{../w.png?width=600&Foo|Alt text}} d {{x.png?href=SomePage}} e {{pic.png?}} f {{id: anchor}} g **{{./in bold.png|a|b}}**\n";
    let images = images_in(text);
    let seen: Vec<(&str, usize, Option<&str>)> = images
        .iter()
        .map(|i| (i.path.as_str(), i.query.len(), i.alt.as_deref()))
        .collect();
    assert_eq!(
        seen,
        [
            ("./a.png", 0, None),
            ("./h.png", 1, None),
            ("../w.png", 2, Some("Alt text")),
            ("x.png", 1, None),
            ("pic.png", 1, None),
            ("./in bold.png|a", 0, Some("b")), // the alt text starts at the last |
        ]
    );
    for image in &images {
        assert!(
            text[image.start..image.end].starts_with("{{")
                && text[image.start..image.end].ends_with("}}")
        );
        assert_eq!(
            &text[image.path_start..image.path_end],
            image.path,
            "the path's position"
        );
    }
    assert_eq!(images[1].param("height"), Some("50"));
    assert_eq!(images[2].param("WIDTH"), Some("600"));
    assert_eq!(images[2].param("Foo"), None, "a flag has no value");
    assert_eq!(images[3].param("href"), Some("SomePage"));
    assert_eq!(images[0].param("width"), None);
    assert!(
        images_in("{{{code\nnot {{./an image.png}}\n}}}\n").is_empty(),
        "an object block is not parsed for images"
    );
    assert!(
        images_in("'''\n{{./not.png}}\n'''\n").is_empty(),
        "nor is a code block"
    );
}

#[test]
fn a_notebook_knows_the_images_of_a_page() {
    let mut nb = Notebook::new();
    nb.put(&name("Foo"), "{{./a.png}} and {{./b.png|B}}");
    assert_eq!(
        nb.images(&name("foo"))
            .iter()
            .map(|i| i.path.as_str())
            .collect::<Vec<_>>(),
        ["./a.png", "./b.png"]
    );
    nb.put(&name("Foo"), "no images now");
    assert!(nb.images(&name("Foo")).is_empty());
    assert!(nb.images(&name("Nothing")).is_empty());
}

// ---- renames

fn page_with(nb: &mut Notebook, page: &str, text: &str) {
    nb.put(&name(page), text);
}

#[test]
fn renaming_a_page_moves_its_folder_and_what_is_in_it() {
    let mut nb = with_files(&[
        "Foo/a.png",
        "Foo/Sub/b.png",
        "Foo/Sub/deep/c.png",
        "Foobar/d.png",
        "Other/e.png",
        "top.png",
    ]);
    page_with(&mut nb, "Foo", "{{./a.png}} {{./Sub/b.png}}");
    page_with(&mut nb, "Foo:Sub", "{{./b.png}}");
    let report = nb.rename(&name("Foo"), &name("Qux:Bar"), true).unwrap();
    assert_eq!(
        report.files_moved,
        [
            ("Foo/a.png".to_string(), "Qux/Bar/a.png".to_string()),
            ("Foo/Sub/b.png".to_string(), "Qux/Bar/Sub/b.png".to_string()),
            (
                "Foo/Sub/deep/c.png".to_string(),
                "Qux/Bar/Sub/deep/c.png".to_string()
            ),
        ]
    );
    assert_eq!(
        nb.files().collect::<Vec<_>>(),
        [
            "Foobar/d.png",
            "Other/e.png",
            "Qux/Bar/a.png",
            "Qux/Bar/Sub/b.png",
            "Qux/Bar/Sub/deep/c.png",
            "top.png"
        ]
    );
    // the references that are relative to the moved folder did not have to change
    assert_eq!(
        nb.get(&name("Qux:Bar")),
        Some("{{./a.png}} {{./Sub/b.png}}")
    );
    assert_eq!(nb.get(&name("Qux:Bar:Sub")), Some("{{./b.png}}"));
    assert_eq!((report.links_changed, report.rewritten.len()), (0, 0));
    assert_eq!(
        nb.resolve_file(&name("Qux:Bar:Sub"), "./b.png"),
        found("Qux/Bar/Sub/b.png")
    );
}

#[test]
fn a_reference_to_a_file_that_stays_is_rewritten_to_reach_it_from_the_new_place() {
    let mut nb = with_files(&["Usage/GTD_flowchart.png"]);
    page_with(&mut nb, "Usage", "x");
    page_with(
        &mut nb,
        "Usage:Getting Things Done",
        "====== GTD ======\n\t{{../GTD_flowchart.png}}\nsee [[../GTD_flowchart.png|the chart]]\n",
    );
    let report = nb
        .rename(
            &name("Usage:Getting Things Done"),
            &name("Other:Getting Things Done"),
            true,
        )
        .unwrap();
    assert!(report.files_moved.is_empty());
    assert_eq!(
        nb.get(&name("Other:Getting Things Done")).unwrap(),
        "====== GTD ======\n\t{{../../Usage/GTD_flowchart.png}}\nsee [[../../Usage/GTD_flowchart.png|the chart]]\n"
    );
    assert_eq!((report.links_changed, report.rewritten.len()), (2, 1));
    let page = name("Other:Getting Things Done");
    for image in nb.images(&page) {
        assert_eq!(
            nb.resolve_file(&page, &image.path),
            found("Usage/GTD_flowchart.png")
        );
    }
}

#[test]
fn a_reference_on_another_page_follows_a_file_that_moved() {
    let mut nb = with_files(&["Foo/a.png", "Foo/Sub/b.png"]);
    page_with(&mut nb, "Foo", "x");
    page_with(&mut nb, "Index", "{{../Foo/a.png?width=10|the a}} and [[../Foo/Sub/b.png|b]] and [[../Foo/missing.png]] and {{/abs/x.png}} and [[Foo]]\n");
    let report = nb.rename(&name("Foo"), &name("Bar"), true).unwrap();
    assert_eq!(
        nb.get(&name("Index")).unwrap(),
        "{{../Bar/a.png?width=10|the a}} and [[../Bar/Sub/b.png|b]] and [[../Foo/missing.png]] and {{/abs/x.png}} and [[Bar]]\n",
        "files that exist are followed; a reference to nothing, or to somewhere else, is left as written"
    );
    assert_eq!(report.links_changed, 3);
}

#[test]
fn a_style_without_dot_slash_is_kept() {
    let mut nb = with_files(&["Foo/a.png"]);
    page_with(&mut nb, "Foo", "{{a.png}} {{./a.png}}");
    page_with(&mut nb, "Top", "{{../Foo/a.png}} {{../Foo/a.png}}");
    nb.rename(&name("Foo"), &name("Qux:Foo"), true).unwrap();
    assert_eq!(nb.get(&name("Qux:Foo")).unwrap(), "{{a.png}} {{./a.png}}");
    assert_eq!(
        nb.get(&name("Top")).unwrap(),
        "{{../Qux/Foo/a.png}} {{../Qux/Foo/a.png}}"
    );
}

#[test]
fn without_update_links_files_move_and_references_are_left_alone() {
    let mut nb = with_files(&["Foo/a.png", "Keep/b.png"]);
    page_with(&mut nb, "Foo", "{{./a.png}}");
    page_with(&mut nb, "Keep", "{{../Foo/a.png}} {{./b.png}}");
    let report = nb.rename(&name("Foo"), &name("Bar"), false).unwrap();
    assert_eq!(
        report.files_moved,
        [("Foo/a.png".to_string(), "Bar/a.png".to_string())]
    );
    assert_eq!(nb.get(&name("Keep")), Some("{{../Foo/a.png}} {{./b.png}}"));
    assert_eq!(
        nb.resolve_file(&name("Keep"), "../Foo/a.png"),
        missing("Foo/a.png")
    );
}

#[test]
fn a_rename_that_would_put_a_file_on_another_changes_nothing() {
    let mut nb = with_files(&["Foo/a.png", "Bar/a.png", "Bar/b.png"]);
    page_with(&mut nb, "Foo", "{{./a.png}}");
    let (pages, files): (Vec<String>, Vec<String>) = (
        nb.names().map(|n| n.to_string()).collect(),
        nb.files().map(String::from).collect(),
    );
    assert_eq!(
        nb.rename(&name("Foo"), &name("Bar"), true),
        Err(RenameError::FileTaken("Bar/a.png".to_string()))
    );
    assert_eq!(nb.names().map(|n| n.to_string()).collect::<Vec<_>>(), pages);
    assert_eq!(nb.files().map(String::from).collect::<Vec<_>>(), files);
    assert_eq!(nb.get(&name("Foo")), Some("{{./a.png}}"));
    // a folder that holds other files is fine to move into: the folders merge
    let mut nb = with_files(&["Foo/a.png", "Bar/b.png"]);
    page_with(&mut nb, "Foo", "x");
    nb.rename(&name("Foo"), &name("Bar"), true).unwrap();
    assert_eq!(nb.files().collect::<Vec<_>>(), ["Bar/a.png", "Bar/b.png"]);
}

#[test]
fn renaming_only_the_case_respells_the_files() {
    let mut nb = with_files(&["Foo/a.png"]);
    page_with(&mut nb, "Foo", "{{./a.png}}");
    let report = nb.rename(&name("Foo"), &name("foo"), true).unwrap();
    assert_eq!(
        report.files_moved,
        [("Foo/a.png".to_string(), "foo/a.png".to_string())]
    );
    assert_eq!(nb.files().collect::<Vec<_>>(), ["foo/a.png"]);
    assert_eq!(nb.get(&name("foo")), Some("{{./a.png}}"));
    // and naming a page what it is already called does nothing
    let report = nb.rename(&name("foo"), &name("foo"), true).unwrap();
    assert!(report.files_moved.is_empty());
}

#[test]
fn a_section_with_no_text_of_its_own_takes_its_files_along() {
    let mut nb = with_files(&["Sec/Page/a.png", "Sec/x.png"]);
    page_with(&mut nb, "Sec:Page", "{{./a.png}}");
    nb.rename(&name("Sec"), &name("Moved"), true).unwrap();
    assert_eq!(
        nb.files().collect::<Vec<_>>(),
        ["Moved/Page/a.png", "Moved/x.png"]
    );
}

#[test]
fn deleting_a_page_with_its_pages_takes_its_files() {
    let mut nb = with_files(&["Foo/a.png", "Foo/Sub/b.png", "Foobar/c.png"]);
    page_with(&mut nb, "Foo", "x");
    page_with(&mut nb, "Foo:Sub", "y");
    page_with(&mut nb, "Foobar", "z");
    assert_eq!(nb.remove_tree(&name("Foo")).len(), 2);
    assert_eq!(
        nb.remove_files_below(&name("Foo")),
        ["Foo/a.png", "Foo/Sub/b.png"]
    );
    assert_eq!(nb.files().collect::<Vec<_>>(), ["Foobar/c.png"]);
}

// ---- found by review

#[test]
fn a_name_that_zim_would_read_as_a_page_is_never_a_file() {
    assert!(check_file_path("Home/notes.txt").is_err());
    assert!(check_file_path("Home/NOTES.TXT").is_err());
    assert!(check_file_path("notes.txt").is_err());
    assert!(
        check_file_path("Home/x.txt/pic.png").is_ok(),
        "only the file's own name counts"
    );
    assert!(check_file_path("Home/notes.text").is_ok());
    assert_eq!(safe_file_name("notes.txt"), "notes.txt.text");
    assert_eq!(safe_file_name("Notes.TXT"), "Notes.TXT.text");
    assert_eq!(safe_file_name("a.text"), "a.text");
    let mut nb = Notebook::new();
    nb.put(&name("Home"), "h");
    nb.put(&name("Home:notes"), "n");
    assert_eq!(
        nb.attachment_path(&name("Home"), "notes.txt").unwrap(),
        "Home/notes.txt.text",
        "so an attachment never has the path of a page, or becomes one when the notebook is read again"
    );
    assert!(nb.put_file("Home/notes.txt").is_err());
}

#[test]
fn a_new_attachment_never_takes_the_name_of_a_folder_a_page_or_a_section() {
    let mut nb = with_files(&["A/Dir/x.png", "A/Sub/pic.png"]);
    nb.put(&name("A"), "a");
    nb.put(&name("A:Sub"), "s");
    nb.put(&name("A:Sec:Child"), "c");
    nb.put(&name("A:Plain"), "p");
    let a = name("A");
    assert_eq!(nb.attachment_path(&a, "Dir").unwrap(), "A/Dir 2");
    assert_eq!(nb.attachment_path(&a, "Sub").unwrap(), "A/Sub 2");
    assert_eq!(nb.attachment_path(&a, "sec").unwrap(), "A/sec 2");
    assert_eq!(nb.attachment_path(&a, "Plain").unwrap(), "A/Plain 2");
    assert_eq!(nb.attachment_path(&a, "Other").unwrap(), "A/Other");
}

#[test]
fn a_path_is_never_both_a_file_and_a_folder() {
    let mut nb = Notebook::new();
    nb.put_file("A/Sub").unwrap();
    let error = nb.put_file("A/Sub/pic.png").unwrap_err();
    assert!(
        error.to_string().contains("both a file and a folder"),
        "{error}"
    );
    let mut nb = Notebook::new();
    nb.put_file("A/Sub/pic.png").unwrap();
    assert!(nb.put_file("A/Sub").is_err());
    assert!(nb.put_file("a/SUB/other.png").is_ok());
    assert_eq!(nb.file_count(), 2);
    // a page whose folder is a file can't take attachments
    let mut nb = with_files(&["A/Sub"]);
    nb.put(&name("A:Sub"), "s");
    let error = nb
        .attachment_path(&name("A:Sub"), "pic.png")
        .unwrap_err();
    assert!(error.to_string().contains("A/Sub"), "{error}");
}

#[test]
fn a_rename_that_would_make_a_file_a_folder_or_a_folder_a_file_changes_nothing() {
    // the folder of the page would be a file that stays
    let mut nb = with_files(&["X/pic.png", "A/Sub"]);
    nb.put(&name("X"), "x");
    assert_eq!(
        nb.rename(&name("X"), &name("A:Sub"), true),
        Err(RenameError::FileAndFolder("A/Sub".to_string()))
    );
    assert_eq!(nb.files().collect::<Vec<_>>(), ["A/Sub", "X/pic.png"]);
    // even a page with no files of its own
    let mut nb = with_files(&["A/Sub"]);
    nb.put(&name("X"), "x");
    assert_eq!(
        nb.rename(&name("X"), &name("A:Sub"), true),
        Err(RenameError::FileAndFolder("A/Sub".to_string()))
    );
    // a file moving where a folder of files that stay is
    let mut nb = with_files(&["X/Sub", "A/Sub/pic.png"]);
    nb.put(&name("X"), "x");
    assert_eq!(
        nb.rename(&name("X"), &name("A"), true),
        Err(RenameError::FileAndFolder("A/Sub/pic.png".to_string()))
    );
    assert_eq!(nb.files().collect::<Vec<_>>(), ["A/Sub/pic.png", "X/Sub"]);
    assert!(nb.has_page(&name("X")));
    // inside a "folder" that is a file that stays
    let mut nb = with_files(&["X/Dir/pic.png", "A/Dir"]);
    nb.put(&name("X"), "x");
    assert_eq!(
        nb.rename(&name("X"), &name("A"), true),
        Err(RenameError::FileAndFolder("A/Dir".to_string()))
    );
    // moving into a folder that holds other files is still fine
    let mut nb = with_files(&["X/a.png", "A/b.png"]);
    nb.put(&name("X"), "x");
    nb.rename(&name("X"), &name("A"), true).unwrap();
    assert_eq!(nb.files().collect::<Vec<_>>(), ["A/a.png", "A/b.png"]);
}

#[test]
fn a_reference_rewritten_by_a_rename_is_still_a_reference() {
    // `Notes:Ab` moves to `Notes`: `../report.pdf` is now `./report.pdf`, and a link that lost
    // its slash would be a link to a page; `~t.png` and `C:x.png` read as places outside
    let mut nb = with_files(&["Notes/report.pdf", "Notes/~t.png", "Notes/c:x.png"]);
    nb.put(
        &name("Notes:Ab"),
        "[[../report.pdf|the report]] {{../~t.png}} {{../c:x.png}} {{../report.pdf}}\n",
    );
    nb.rename(&name("Notes:Ab"), &name("Notes"), true).unwrap();
    let text = nb.get(&name("Notes")).unwrap().to_string();
    assert_eq!(
        text,
        "[[./report.pdf|the report]] {{./~t.png}} {{./c:x.png}} {{report.pdf}}\n",
        "a bare name stays bare only where it still reads as a file in the same folder"
    );
    assert_eq!(classify("./report.pdf"), LinkKind::File);
    for image in nb.images(&name("Notes")) {
        assert!(
            matches!(
                nb.resolve_file(&name("Notes"), &image.path),
                FileTarget::Notebook { exists: true, .. }
            ),
            "{}",
            image.path
        );
    }
    let link = &nb.links(&name("Notes"))[0];
    assert_eq!(classify(&link.target), LinkKind::File);
    assert!(matches!(
        nb.resolve_file(&name("Notes"), &link.target),
        FileTarget::Notebook { exists: true, .. }
    ));
}

#[test]
fn a_reference_to_a_file_with_awkward_characters_is_escaped_so_that_it_stays_one() {
    let files = [
        "what?.png",
        "a|b.png",
        "a}}b.png",
        "a]]b.png",
        "50%.png",
        "h#sh.png",
        "br[ack]et.png",
        "sp ace.png",
        "\u{e9}.png",
        "~t.png",
        "c:x.png",
    ];
    let mut nb = Notebook::new();
    nb.put(&name("A"), "x");
    for file in files {
        nb.put_file(&format!("A/{file}")).unwrap();
    }
    for file in files {
        let text = nb.file_link(&name("A"), &format!("A/{file}"));
        // as an image and as a link: each is one reference, and leads to this file
        nb.put(&name("A"), format!("{{{{{text}}}}} and [[{text}|shown]]\n"));
        let images = nb.images(&name("A"));
        assert_eq!(images.len(), 1, "{file}: written as {text:?}");
        let links = nb.links(&name("A"));
        assert_eq!(links.len(), 1, "{file}: written as {text:?}");
        assert_eq!(classify(&links[0].target), LinkKind::File, "{file}");
        for target in [&images[0].path, &links[0].target] {
            assert_eq!(
                nb.resolve_file(&name("A"), target),
                FileTarget::Notebook {
                    path: format!("A/{file}"),
                    exists: true
                },
                "{file}: written as {target:?}"
            );
        }
    }
}

#[test]
fn a_file_named_like_the_escaped_name_of_another_is_found_as_written_first() {
    // (only an import could make this pair: the pair of names is why the order is documented)
    let nb = with_files(&["A/a%7Cb.png", "A/a|b.png"]);
    assert_eq!(
        nb.resolve_file(&name("A"), "./a%7Cb.png"),
        found("A/a%7Cb.png")
    );
}
