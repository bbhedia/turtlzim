//! Page names: what is accepted, what is refused, and how they map to files.

mod common;
use common::{name, Rng};
use zim_notebook::{NameError, PageName};

#[test]
fn names_are_read_the_way_zim_reads_them() {
    for (input, expected) in [
        ("Foo", "Foo"),
        ("Foo:Bar", "Foo:Bar"),
        (":Foo:Bar", "Foo:Bar"),      // an absolute link's leading colon
        (":Journal:", "Journal"),     // a section written with both
        ("  Foo : Bar  ", "Foo:Bar"), // each part is trimmed
        ("Auto_Formatting", "Auto Formatting"), // a file name's underscore is a space
        ("Help:Auto_Formatting", "Help:Auto Formatting"),
        ("日本語:ページ", "日本語:ページ"),
        (
            "Plugins:Table Editor:Basic Table Operations",
            "Plugins:Table Editor:Basic Table Operations",
        ),
        ("2026-10-06", "2026-10-06"),
        ("C++ notes", "C++ notes"),
        ("What's new (v2)", "What's new (v2)"),
        ("+plus", "+plus"),
    ] {
        assert_eq!(
            PageName::parse(input).unwrap().as_str(),
            expected,
            "{input:?}"
        );
    }
}

#[test]
fn what_zim_forbids_is_refused() {
    for c in zim_notebook::FORBIDDEN {
        assert_eq!(
            PageName::parse(&format!("a{c}b")),
            Err(NameError::Forbidden(*c)),
            "{c}"
        );
        assert_eq!(
            PageName::parse(&format!("Foo:a{c}b")),
            Err(NameError::Forbidden(*c)),
            "{c} in a deeper level"
        );
    }
    assert_eq!(PageName::parse(""), Err(NameError::Empty));
    assert_eq!(PageName::parse("   "), Err(NameError::Empty));
    assert_eq!(PageName::parse(":"), Err(NameError::Empty));
    assert_eq!(PageName::parse("Foo::Bar"), Err(NameError::EmptyLevel));
    assert_eq!(PageName::parse("::Foo"), Err(NameError::EmptyLevel));
    assert_eq!(PageName::parse("Foo: :Bar"), Err(NameError::EmptyLevel));
    assert_eq!(PageName::parse("a\u{0}b"), Err(NameError::Control));
    assert_eq!(PageName::parse("a\nb"), Err(NameError::Control));
    // A level starting with a dot would be a hidden file, and ".." would leave the folder.
    for bad in [".hidden", "Foo:.hidden", ".", "..", "Foo:..", "Foo:..:Bar"] {
        assert_eq!(PageName::parse(bad), Err(NameError::LeadingDot), "{bad}");
    }
    assert!(PageName::parse("not.hidden").is_ok());
    assert_eq!(PageName::parse(&"x".repeat(201)), Err(NameError::TooLong));
    assert!(PageName::parse(&"x".repeat(200)).is_ok());
    assert_eq!(
        PageName::parse(&vec!["x".repeat(150); 8].join(":")),
        Err(NameError::TooLong)
    );
}

#[test]
fn the_error_messages_say_what_to_fix() {
    let message = PageName::parse("a*b").unwrap_err().to_string();
    assert!(
        message.contains("'*'") && message.contains("? # / \\"),
        "{message}"
    );
}

#[test]
fn the_parts_of_a_name() {
    let n = name("Projects:Garden:Plan");
    assert_eq!((n.depth(), n.last()), (3, "Plan"));
    assert_eq!(
        n.levels().collect::<Vec<_>>(),
        ["Projects", "Garden", "Plan"]
    );
    assert_eq!(n.parent().unwrap().as_str(), "Projects:Garden");
    assert_eq!(n.parent().unwrap().parent().unwrap().parent(), None);
    assert_eq!(n.prefix(1).as_str(), "Projects");
    assert_eq!(n.prefix(2).as_str(), "Projects:Garden");
    assert_eq!(n.prefix(99), n);
    assert_eq!(
        n.child("Sub:Page").unwrap().as_str(),
        "Projects:Garden:Plan:Sub:Page"
    );
    assert!(n.child("bad*").is_err());
    assert_eq!(
        n.child(""),
        Err(NameError::Empty),
        "nothing below is not the page itself"
    );
    assert_eq!(n.child("  "), Err(NameError::Empty));
    assert_eq!(n.child(":x"), Err(NameError::EmptyLevel));
    assert_eq!(name("Top").parent(), None);
    assert_eq!((name("Top").depth(), name("Top").last()), (1, "Top"));
}

#[test]
fn names_compare_without_regard_to_case_but_keep_their_spelling() {
    assert!(name("Help:Links").same_page(&name("help:LINKS")));
    assert!(!name("Help:Links").same_page(&name("Help:Link")));
    assert_eq!(name("Help:Links").as_str(), "Help:Links");
    assert_eq!(name("ÉCOLE").key(), "école");
}

#[test]
fn a_page_is_inside_only_what_it_is_below() {
    let foo = name("Foo");
    assert!(name("Foo:Bar").is_inside(&foo));
    assert!(name("foo:bar:baz").is_inside(&foo));
    assert!(!name("Foo").is_inside(&foo), "not inside itself");
    assert!(
        !name("Foobar:Baz").is_inside(&foo),
        "a longer first level is another page"
    );
    assert!(!name("Other:Foo").is_inside(&foo));
}

#[test]
fn names_and_files_correspond() {
    for (page, path) in [
        ("Help", "Help.txt"),
        ("Help:Links", "Help/Links.txt"),
        ("Help:Auto Formatting", "Help/Auto_Formatting.txt"),
        (
            "Plugins:Table Editor:Basic Table Operations",
            "Plugins/Table_Editor/Basic_Table_Operations.txt",
        ),
        ("日本語:ページ", "日本語/ページ.txt"),
    ] {
        assert_eq!(name(page).to_path(), path);
        assert_eq!(PageName::from_path(path).unwrap(), name(page), "{path}");
    }
    assert_eq!(
        name("Plugins:Table Editor").folder_path(),
        "Plugins/Table_Editor"
    );
    assert_eq!(
        PageName::from_folder_path("Plugins/Table_Editor").unwrap(),
        name("Plugins:Table Editor")
    );
}

#[test]
fn only_page_files_with_valid_names_are_pages() {
    assert_eq!(
        PageName::from_path("notebook.zim"),
        Err(NameError::NotAPageFile)
    );
    assert_eq!(
        PageName::from_path("Help/Links.png"),
        Err(NameError::NotAPageFile)
    );
    assert_eq!(PageName::from_path(".txt"), Err(NameError::Empty));
    assert!(PageName::from_path(".hidden.txt").is_err());
    assert!(PageName::from_path("Help/.cache/x.txt").is_err());
    assert!(
        PageName::from_path("a:b.txt").is_err(),
        "a colon in a file name isn't a level separator"
    );
    assert!(PageName::from_path("a%20b.txt").is_err());
    assert!(PageName::from_path("a//b.txt").is_err());
    assert!(PageName::from_path("../outside.txt").is_err());
}

#[test]
fn file_paths_never_climb_out_of_the_notebook() {
    // Whatever name is accepted, its path stays inside: no ".." or absolute path can come out.
    let mut rng = Rng(0x1234_5678_9ABC_DEF1);
    let pieces = [
        "a", "B", ".", "..", "/", "\\", ":", " ", "_", "é", "x.y", "~", "%2e", "\u{0}",
    ];
    for _ in 0..30_000 {
        let text: String = (0..1 + rng.below(8))
            .map(|_| pieces[rng.below(pieces.len())])
            .collect();
        if let Ok(n) = PageName::parse(&text) {
            let path = n.to_path();
            assert!(
                !path.starts_with('/')
                    && !path.contains("//")
                    && !path.contains('\\')
                    && !path.contains('\0'),
                "{text:?} -> {path:?}"
            );
            assert!(
                path.split('/')
                    .all(|part| !part.is_empty() && !part.starts_with('.')
                        || part.ends_with(".txt") && part.len() > 4),
                "{text:?} -> {path:?}"
            );
            assert_eq!(
                PageName::from_path(&path).unwrap(),
                n,
                "{text:?}: the path must read back as the same name"
            );
        }
    }
}
