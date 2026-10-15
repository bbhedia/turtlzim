// The folders that the program's notebooks live in: a notebook is a folder of Zim files (pages as `.txt`, the folder named like a page holding
// its attachments, `notebook.zim`), which Zim itself opens. This module is all the program knows of them, and it knows nothing of Tauri:
//
// * the folders the person chose (`Registry`): the page only ever names one by an id, never by a path, and only a folder in the list can be touched;
// * a path inside a folder (`check`, `resolve`): relative, with `/`, no `.` or `..`, nothing hidden, and no link on the way (a link in a notebook
//   folder that leads out of it is not followed, listed or written through);
// * reading (`list`, which also finishes or undoes a change that was cut off, and `read`);
// * a change of many files that happens entirely or not at all (`stage` and `commit`): the new files are written beside the notebook first, every
//   file that is to be replaced, moved or deleted is put aside, the new ones are put in place, and only then is what was put aside let go. A
//   journal says what to put back, so a change that is cut off by a crash is undone the next time the folder is listed.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Where a change is prepared, in the notebook folder. A name that starts with a dot is hidden: it is never listed and never written to by the page.
pub const WORK: &str = ".zim-txn";

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Entry {
    /// Relative to the notebook folder, `/` between folders.
    pub path: String,
    pub size: u64,
    /// When the file was last changed, in ms since the epoch.
    pub modified: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct RootInfo {
    pub id: String,
    pub name: String,
    pub exists: bool,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct PlannedWrite {
    pub path: String,
    /// The number the bytes were staged under.
    pub staged: u32,
}

/// What a change does, in the order that a store says it: files are moved (all read before any is written, so that they can swap places),
/// then deleted, then written; what comes later is what is left at a path.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct Plan {
    #[serde(default)]
    pub writes: Vec<PlannedWrite>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub moves: Vec<(String, String)>,
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// paths

/// The parts of a path inside a notebook folder, or why it is not one.
pub fn check(rel: &str) -> Result<Vec<&str>, String> {
    let bad = || format!("{rel:?} is not a path inside a notebook folder");
    if rel.is_empty() || rel.len() > 4096 || rel.contains('\0') || rel.contains('\\') {
        return Err(bad());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts {
        // (an empty part, `.`, `..` and everything hidden, which is where the program keeps its own work)
        if part.is_empty() || part.starts_with('.') || part.len() > 255 || part.chars().any(|c| c.is_control()) {
            return Err(bad());
        }
        // (Windows reads `a:b` as a stream of a file, and refuses the others, and a name that ends in a space or a dot)
        if cfg!(windows) && (part.contains(['<', '>', ':', '"', '|', '?', '*']) || part.ends_with([' ', '.'])) {
            return Err(bad());
        }
    }
    Ok(parts)
}

/// The place of a path in `root`: no link on the way, or an error.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = check(rel)?;
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err(format!("{rel:?} goes through a link, which a notebook folder does not follow"));
            }
        }
    }
    Ok(path)
}

fn key(path: &str) -> String {
    path.to_lowercase()
}

fn milliseconds(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// reading

/// Every file of the folder that is not hidden and not a link, sorted by path. A change that was cut off is undone first.
pub fn list(root: &Path) -> Result<Vec<Entry>, String> {
    recover(root)?;
    let mut found = Vec::new();
    walk(root, root, &mut found)?;
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

fn walk(root: &Path, dir: &Path, found: &mut Vec<Entry>) -> Result<(), String> {
    let reading = fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;
    for entry in reading {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            walk(root, &path, found)?;
        } else if kind.is_file() {
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            found.push(Entry { path: relative, size: metadata.len(), modified: milliseconds(metadata.modified()) });
        }
    }
    Ok(())
}

pub fn read(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let path = resolve(root, rel)?;
    fs::read(&path).map_err(|e| format!("could not read {rel}: {e}"))
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// a change

#[derive(Serialize, Deserialize, Debug)]
struct Original {
    path: String,
    /// The name it is put aside under (`old/<k>`).
    k: u32,
    existed: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct Journal {
    originals: Vec<Original>,
    dests: Vec<String>,
}

#[derive(Clone, Debug)]
enum Source {
    Old(u32),
    Staged(u32),
}

fn check_transaction(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("a change is named by letters, digits, - and _".into());
    }
    Ok(())
}

fn base(root: &Path, transaction: &str) -> PathBuf {
    root.join(WORK).join(transaction)
}

/// Write the bytes of a file that a change is going to put in place, beside the notebook, under a number, with the time (ms since the epoch) that
/// the file is to say it was changed. Nothing of the notebook changes.
pub fn stage(root: &Path, transaction: &str, number: u32, bytes: &[u8], modified: Option<u64>) -> Result<(), String> {
    check_transaction(transaction)?;
    let dir = base(root, transaction).join("new");
    fs::create_dir_all(&dir).map_err(|e| format!("could not prepare a change: {e}"))?;
    let mut file = fs::File::create(dir.join(number.to_string())).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    if let Some(ms) = modified {
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(ms)).map_err(|e| format!("could not set the time of a file: {e}"))?;
    }
    file.sync_all().map_err(|e| e.to_string())
}

/// Make a change: everything in the plan happens, or nothing does. The staged files that it names are put in place (and used up).
pub fn commit(root: &Path, transaction: &str, plan: &Plan) -> Result<(), String> {
    let prepared = match prepare(root, transaction, plan) {
        Ok(prepared) => prepared,
        Err(error) => {
            // (a plan that was refused before anything was touched leaves only what was staged for it, which is no use now)
            let work = base(root, transaction);
            if !work.join("journal.json").exists() && check_transaction(transaction).is_ok() {
                let _ = fs::remove_dir_all(work);
            }
            return Err(error);
        }
    };
    match place(root, &prepared) {
        Ok(()) => finish(root, transaction, plan),
        Err(error) => {
            let undone = rollback(root, &base(root, transaction));
            Err(match undone {
                Ok(()) => error,
                Err(second) => format!("{error} (and putting back what was there failed: {second})"),
            })
        }
    }
}

struct Prepared {
    base: PathBuf,
    originals: Vec<Original>,
    /// What each path is to hold afterwards, by its key: the spelling it is written under, and where the bytes are.
    result: HashMap<String, (String, Source)>,
}

/// Check the plan, write the journal, and put aside every file that the change touches. (A change that is cut off after this is undone by `recover`.)
fn prepare(root: &Path, transaction: &str, plan: &Plan) -> Result<Prepared, String> {
    check_transaction(transaction)?;
    let base = base(root, transaction);
    let mut affected: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |path: &str| -> Result<(), String> {
        check(path)?;
        resolve(root, path)?;
        // (every spelling that the plan names, not one for each name that ignores case: on a disk that tells `Foo` from `foo` they are two files, and
        // the one that is deleted or written over must not be the only one that is left)
        if seen.insert(path.to_string()) {
            affected.push(path.to_string());
        }
        Ok(())
    };
    for (from, to) in &plan.moves {
        add(from)?;
        add(to)?;
    }
    for path in &plan.deletes {
        add(path)?;
    }
    for write in &plan.writes {
        add(&write.path)?;
        if !base.join("new").join(write.staged.to_string()).is_file() {
            return Err(format!("the bytes of {} were not staged", write.path));
        }
    }

    let mut originals = Vec::new();
    let mut before: HashMap<String, (String, Source)> = HashMap::new();
    for (k, path) in affected.iter().enumerate() {
        let place = resolve(root, path)?;
        let existed = place.exists();
        if existed && !place.is_file() {
            return Err(format!("{path} is a folder, not a file"));
        }
        originals.push(Original { path: path.clone(), k: k as u32, existed });
        if existed {
            before.insert(key(path), (path.clone(), Source::Old(k as u32)));
        }
    }
    // the state afterwards, in the order that a store says: what is moved is read first, then what goes goes, what comes comes, what is written is last
    let mut result = before.clone();
    for (from, _) in &plan.moves {
        result.remove(&key(from));
    }
    for path in &plan.deletes {
        result.remove(&key(path));
    }
    for (from, to) in &plan.moves {
        if let Some((_, source)) = before.get(&key(from)) {
            result.insert(key(to), (to.clone(), source.clone()));
        }
    }
    for write in &plan.writes {
        result.insert(key(&write.path), (write.path.clone(), Source::Staged(write.staged)));
    }

    let journal = Journal { originals: originals.iter().map(|o| Original { path: o.path.clone(), k: o.k, existed: o.existed }).collect(), dests: result.values().map(|(path, _)| path.clone()).collect() };
    fs::create_dir_all(base.join("old")).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(&journal).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(base.join("journal.json")).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;

    let prepared = Prepared { base: base.clone(), originals, result };
    for original in &prepared.originals {
        if !original.existed {
            continue;
        }
        let from = resolve(root, &original.path)?;
        if from.exists() {
            if let Err(error) = fs::rename(&from, base.join("old").join(original.k.to_string())) {
                let _ = rollback(root, &base);
                return Err(format!("could not put {} aside: {error}", original.path));
            }
        }
    }
    Ok(prepared)
}

/// Put the new state in place: what was put aside comes back where the change says (as a link, so that it is still there to undo this), and what was staged is moved in.
fn place(root: &Path, prepared: &Prepared) -> Result<(), String> {
    for (spelled, source) in prepared.result.values() {
        let dest = resolve(root, spelled)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("could not make the folder of {spelled}: {e}"))?;
        }
        match source {
            Source::Old(k) => {
                let saved = prepared.base.join("old").join(k.to_string());
                if fs::hard_link(&saved, &dest).is_err() {
                    fs::copy(&saved, &dest).map_err(|e| format!("could not write {spelled}: {e}"))?;
                }
            }
            Source::Staged(n) => {
                fs::rename(prepared.base.join("new").join(n.to_string()), &dest).map_err(|e| format!("could not write {spelled}: {e}"))?;
            }
        }
    }
    Ok(())
}

/// The change is made: what was put aside is let go, and the folders that it left empty go.
fn finish(root: &Path, transaction: &str, plan: &Plan) -> Result<(), String> {
    let base = base(root, transaction);
    fs::remove_dir_all(&base).map_err(|e| format!("the change was made, but its work folder could not be removed: {e}"))?;
    let _ = fs::remove_dir(root.join(WORK));
    let mut gone: Vec<&String> = plan.deletes.iter().collect();
    gone.extend(plan.moves.iter().map(|(from, _)| from));
    for path in gone {
        let Ok(place) = resolve(root, path) else { continue };
        let mut dir = place.parent().map(Path::to_path_buf);
        while let Some(current) = dir {
            if current == root || fs::remove_dir(&current).is_err() {
                break;
            }
            dir = current.parent().map(Path::to_path_buf);
        }
    }
    Ok(())
}

/// Undo a change, from its journal: what is at a path that the change was to write is removed (if the original was already put aside, or there was none),
/// and what was put aside is put back. It can be done again after it was cut off.
fn rollback(root: &Path, base: &Path) -> Result<(), String> {
    if let Ok(text) = fs::read_to_string(base.join("journal.json")) {
        let journal: Journal = serde_json::from_str(&text).map_err(|e| format!("the journal of a change can't be read: {e}"))?;
        let old = base.join("old");
        for dest in &journal.dests {
            let Ok(place) = resolve(root, dest) else { continue };
            // (the original at this path: spelled the same, or, on a disk that ignores case, the one that has the same name)
            let original = journal.originals.iter().find(|o| o.path == *dest).or_else(|| journal.originals.iter().find(|o| key(&o.path) == key(dest)));
            let free = match original {
                Some(original) => !original.existed || old.join(original.k.to_string()).exists(),
                None => true,
            };
            if free && place.is_file() {
                fs::remove_file(&place).map_err(|e| e.to_string())?;
            }
        }
        for original in &journal.originals {
            let saved = old.join(original.k.to_string());
            if !original.existed || !saved.exists() {
                continue;
            }
            let place = resolve(root, &original.path)?;
            if let Some(parent) = place.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if place.is_file() {
                fs::remove_file(&place).map_err(|e| e.to_string())?;
            }
            fs::rename(&saved, &place).map_err(|e| format!("could not put {} back: {e}", original.path))?;
        }
    }
    fs::remove_dir_all(base).map_err(|e| e.to_string())
}

/// Undo every change that was cut off (a crash, a power cut), and clear away what was staged for one that never began.
pub fn recover(root: &Path) -> Result<(), String> {
    let work = root.join(WORK);
    let Ok(reading) = fs::read_dir(&work) else { return Ok(()) };
    for entry in reading.flatten() {
        if entry.path().is_dir() {
            rollback(root, &entry.path())?;
        }
    }
    let _ = fs::remove_dir(&work);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the folders that were chosen

pub struct Registry {
    file: PathBuf,
    /// In the order they were chosen.
    roots: Vec<SavedRoot>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SavedRoot {
    id: String,
    path: PathBuf,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    roots: Vec<SavedRoot>,
}

impl Registry {
    /// The registry kept in `file` (empty if there is none, or it can't be read: a folder that is no longer listed is chosen again).
    pub fn load(file: PathBuf) -> Registry {
        let roots = fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str::<Saved>(&text).ok()).unwrap_or_default().roots;
        Registry { file, roots }
    }

    pub fn infos(&self) -> Vec<RootInfo> {
        self.roots.iter().map(|root| RootInfo { id: root.id.clone(), name: folder_name(&root.path), exists: root.path.is_dir() }).collect()
    }

    /// The folder `path` is listed (once, whatever the way to it), and has an id.
    pub fn add(&mut self, path: &Path) -> Result<RootInfo, String> {
        let real = fs::canonicalize(path).map_err(|e| format!("could not open {}: {e}", path.display()))?;
        if !real.is_dir() {
            return Err(format!("{} is not a folder", real.display()));
        }
        let id = match self.roots.iter().find(|known| known.path == real) {
            Some(known) => known.id.clone(),
            None => {
                let id = fresh_id();
                self.roots.push(SavedRoot { id: id.clone(), path: real.clone() });
                self.save()?;
                id
            }
        };
        Ok(RootInfo { id, name: folder_name(&real), exists: true })
    }

    /// Stop listing a folder. Nothing in it is touched.
    pub fn forget(&mut self, id: &str) -> Result<(), String> {
        self.roots.retain(|root| root.id != id);
        self.save()
    }

    pub fn path(&self, id: &str) -> Result<PathBuf, String> {
        let root = self.roots.iter().find(|root| root.id == id).ok_or_else(|| "that folder is not one of the notebooks".to_string())?;
        if !root.path.is_dir() {
            return Err(format!("{} is not there any more", root.path.display()));
        }
        Ok(root.path.clone())
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(&Saved { roots: self.roots.clone() }).map_err(|e| e.to_string())?;
        let temporary = self.file.with_extension("json.tmp");
        fs::write(&temporary, text).map_err(|e| e.to_string())?;
        fs::rename(&temporary, &self.file).map_err(|e| e.to_string())
    }
}

fn folder_name(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or("notebook").to_string()
}

fn fresh_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A folder of its own for a test, removed at the end.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Scratch {
            let path = std::env::temp_dir().join(format!("zim-folders-test-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(&path).unwrap();
            Scratch(fs::canonicalize(path).unwrap())
        }
        fn put(&self, rel: &str, text: &str) {
            let place = self.0.join(rel);
            fs::create_dir_all(place.parent().unwrap()).unwrap();
            fs::write(place, text).unwrap();
        }
        fn text(&self, rel: &str) -> Option<String> {
            fs::read_to_string(self.0.join(rel)).ok()
        }
        fn files(&self) -> Vec<String> {
            list(&self.0).unwrap().into_iter().map(|e| e.path).collect()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn plan(writes: &[(&str, u32)], deletes: &[&str], moves: &[(&str, &str)]) -> Plan {
        Plan {
            writes: writes.iter().map(|(path, staged)| PlannedWrite { path: path.to_string(), staged: *staged }).collect(),
            deletes: deletes.iter().map(|p| p.to_string()).collect(),
            moves: moves.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
        }
    }

    #[test]
    fn a_path_is_inside_the_notebook_or_it_is_refused() {
        for good in ["Home.txt", "Projects/Garden.txt", "Projects/Garden/Bed 1.png", "notebook.zim", "a/b/c/d.txt", "Zürich/Café.txt"] {
            assert!(check(good).is_ok(), "{good}");
        }
        for bad in ["", "/etc/passwd", "a//b", "a/", "./a", "a/./b", "../a", "a/../b", ".hidden", "a/.git/config", ".zim-txn/x", "a\\b", "a\0b", &"x".repeat(256), &"a/".repeat(2100)] {
            assert!(check(bad).is_err(), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_folder_is_not_followed_or_listed() {
        let root = Scratch::new();
        let outside = Scratch::new();
        outside.put("secret.txt", "not for the notebook");
        root.put("Home.txt", "home");
        std::os::unix::fs::symlink(&outside.0, root.0.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.txt"), root.0.join("Secret.txt")).unwrap();
        assert_eq!(root.files(), ["Home.txt"]);
        assert!(resolve(&root.0, "link/secret.txt").is_err());
        assert!(read(&root.0, "link/secret.txt").is_err());
        assert!(read(&root.0, "Secret.txt").is_err());
        assert!(commit(&root.0, "t1", &plan(&[], &["link/secret.txt"], &[])).is_err());
        assert_eq!(outside.text("secret.txt").as_deref(), Some("not for the notebook"));
    }

    #[test]
    fn listing_skips_what_is_hidden_and_sorts() {
        let root = Scratch::new();
        root.put("b.txt", "b");
        root.put("A/c.txt", "c");
        root.put(".git/config", "x");
        root.put(".hidden.txt", "x");
        root.put("A/.cache/y", "y");
        root.put("notebook.zim", "[Notebook]\n");
        let found = list(&root.0).unwrap();
        assert_eq!(found.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["A/c.txt", "b.txt", "notebook.zim"]);
        assert_eq!(found[0].size, 1);
        assert!(found[0].modified > 1_600_000_000_000);
    }

    #[test]
    fn a_change_writes_moves_deletes_and_tidies_up() {
        let root = Scratch::new();
        root.put("Foo.txt", "foo");
        root.put("Foo/a.png", "A");
        root.put("Foo/Sub/b.png", "B");
        root.put("Gone.txt", "gone");
        stage(&root.0, "t", 0, b"bar page", Some(5_000)).unwrap();
        stage(&root.0, "t", 1, b"new", None).unwrap();
        // Foo and its folder become Bar; Gone goes; New is written
        commit(&root.0, "t", &plan(&[("Bar.txt", 0), ("New.txt", 1)], &["Foo.txt", "Gone.txt"], &[("Foo/a.png", "Bar/a.png"), ("Foo/Sub/b.png", "Bar/Sub/b.png")])).unwrap();
        assert_eq!(root.files(), ["Bar.txt", "Bar/Sub/b.png", "Bar/a.png", "New.txt"]);
        assert_eq!(root.text("Bar/a.png").as_deref(), Some("A"));
        assert_eq!(root.text("Bar/Sub/b.png").as_deref(), Some("B"));
        assert_eq!(root.text("Bar.txt").as_deref(), Some("bar page"));
        let times: Vec<(String, u64)> = list(&root.0).unwrap().into_iter().map(|e| (e.path, e.modified)).collect();
        assert_eq!(times.iter().find(|(p, _)| p == "Bar.txt").unwrap().1, 5_000, "the time that a file was given is the time it has");
        assert!(times.iter().find(|(p, _)| p == "Bar/a.png").unwrap().1 > 1_600_000_000_000, "and a moved file keeps its own");
        assert!(!root.0.join("Foo").exists(), "the folder that was left empty is gone");
        assert!(!root.0.join(WORK).exists(), "and no work is left");
    }

    #[test]
    fn files_swap_places_change_only_their_case_and_are_replaced() {
        let root = Scratch::new();
        root.put("x.png", "X");
        root.put("y.png", "Y");
        root.put("Case/a.png", "A");
        root.put("old.txt", "old");
        stage(&root.0, "t", 0, b"newer", None).unwrap();
        commit(&root.0, "t", &plan(&[("old.txt", 0)], &[], &[("x.png", "y.png"), ("y.png", "x.png"), ("Case/a.png", "case/A.png")])).unwrap();
        assert_eq!(root.text("x.png").as_deref(), Some("Y"));
        assert_eq!(root.text("y.png").as_deref(), Some("X"));
        assert_eq!(root.files(), ["case/A.png", "old.txt", "x.png", "y.png"]);
        assert_eq!(root.text("old.txt").as_deref(), Some("newer"));
    }

    #[test]
    fn what_is_written_is_last_and_a_move_of_a_missing_file_moves_nothing() {
        let root = Scratch::new();
        root.put("a.png", "old A");
        root.put("b.png", "B");
        stage(&root.0, "t", 0, b"new A", None).unwrap();
        stage(&root.0, "t", 1, b"over the moved one", None).unwrap();
        commit(&root.0, "t", &plan(&[("a.png", 0), ("C.PNG", 1)], &[], &[("a.png", "moved.png"), ("b.png", "c.png"), ("nothing.png", "z.png")])).unwrap();
        assert_eq!(root.files(), ["C.PNG", "a.png", "moved.png"]);
        assert_eq!(root.text("a.png").as_deref(), Some("new A"));
        assert_eq!(root.text("moved.png").as_deref(), Some("old A"));
        assert_eq!(root.text("C.PNG").as_deref(), Some("over the moved one"));
    }

    #[test]
    fn a_change_that_fails_leaves_the_notebook_as_it_was() {
        let root = Scratch::new();
        root.put("A.txt", "a");
        root.put("A/p.png", "p");
        root.put("B.txt", "b");
        stage(&root.0, "t", 0, b"written", None).unwrap();
        // the second write was never staged: nothing may happen
        let failing = plan(&[("New.txt", 0), ("Other.txt", 7)], &["B.txt"], &[("A/p.png", "Z/p.png")]);
        assert!(commit(&root.0, "t", &failing).is_err());
        assert_eq!(root.files(), ["A.txt", "A/p.png", "B.txt"]);
        assert_eq!(root.text("B.txt").as_deref(), Some("b"));
        assert!(!root.0.join(WORK).join("t").exists(), "what was staged for a change that was refused is cleared away");
        // and a failure while the new state is being put in place is undone too: a file is where a folder is to be made
        stage(&root.0, "u", 0, b"x", None).unwrap();
        stage(&root.0, "u", 1, b"y", None).unwrap();
        root.put("Blocked", "a file");
        let blocked = plan(&[("New.txt", 0), ("Blocked/inner.txt", 1)], &["A.txt"], &[("B.txt", "Moved.txt")]);
        assert!(commit(&root.0, "u", &blocked).is_err());
        assert_eq!(root.text("Blocked").as_deref(), Some("a file"));
        assert_eq!(root.text("A.txt").as_deref(), Some("a"));
        assert_eq!(root.text("B.txt").as_deref(), Some("b"));
        assert!(!root.0.join("New.txt").exists() && !root.0.join("Moved.txt").exists());
        assert!(!root.0.join(WORK).join("u").exists());
    }

    #[test]
    fn a_change_that_was_cut_off_is_undone_when_the_folder_is_listed() {
        let root = Scratch::new();
        root.put("A.txt", "a");
        root.put("A/p.png", "p");
        root.put("B.txt", "b");
        stage(&root.0, "t", 0, b"written", None).unwrap();
        // the program dies after the originals were put aside and part of the new state was placed
        let changing = plan(&[("New.txt", 0)], &["B.txt"], &[("A/p.png", "Z/p.png"), ("A.txt", "Z.txt")]);
        let prepared = prepare(&root.0, "t", &changing).unwrap();
        let (spelled, source) = prepared.result.values().find(|(path, _)| path == "Z.txt").unwrap();
        fs::hard_link(prepared.base.join("old").join(match source { Source::Old(k) => k.to_string(), _ => unreachable!() }), root.0.join(spelled)).unwrap();
        assert!(!root.0.join("A.txt").exists() && root.0.join("Z.txt").exists());
        assert!(root.0.join("Z.txt").exists() && !root.0.join("B.txt").exists(), "half of it is there");
        // the next time the folder is listed it is as it was
        assert!(root.0.join(WORK).exists());
        let mut again = root.files();
        again.sort();
        assert_eq!(again, ["A.txt", "A/p.png", "B.txt"]);
        assert_eq!(root.text("B.txt").as_deref(), Some("b"));
        assert_eq!(root.text("A/p.png").as_deref(), Some("p"));
        assert!(!root.0.join(WORK).exists());
    }

    #[test]
    fn a_folder_where_a_file_is_to_be_written_refuses_the_change_and_changes_nothing() {
        let root = Scratch::new();
        root.put("A.txt", "a");
        fs::create_dir_all(root.0.join("Blocked.txt/inner")).unwrap();
        stage(&root.0, "t", 0, b"x", None).unwrap();
        stage(&root.0, "t", 1, b"y", None).unwrap();
        let error = commit(&root.0, "t", &plan(&[("Blocked.txt", 0), ("New.txt", 1)], &["A.txt"], &[])).unwrap_err();
        assert!(error.contains("is a folder"), "{error}");
        assert_eq!(root.text("A.txt").as_deref(), Some("a"));
        assert!(root.0.join("Blocked.txt/inner").is_dir() && !root.0.join("New.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_spelling_that_is_deleted_goes_when_another_spelling_of_the_name_is_written() {
        // (a disk that tells `FOO` from `foo`: the notebook's names ignore case, so a file that is written over, or moved onto, replaces the one that has the name)
        let root = Scratch::new();
        root.put("FOO/A.png", "old");
        root.put("Bar/b.png", "B");
        commit(&root.0, "t", &plan(&[], &["FOO/A.png"], &[("Bar/b.png", "foo/a.PNG")])).unwrap();
        assert_eq!(root.files(), ["foo/a.PNG"]);
        assert_eq!(root.text("foo/a.PNG").as_deref(), Some("B"));
    }

    #[test]
    fn what_was_staged_for_a_change_that_never_began_is_cleared_away() {
        let root = Scratch::new();
        root.put("A.txt", "a");
        stage(&root.0, "never", 0, b"big", None).unwrap();
        assert_eq!(root.files(), ["A.txt"]);
        assert!(!root.0.join(WORK).exists());
    }

    #[test]
    fn a_change_and_a_staged_file_are_named_safely_and_their_paths_are_checked() {
        let root = Scratch::new();
        root.put("A.txt", "a");
        assert!(stage(&root.0, "../escape", 0, b"x", None).is_err());
        assert!(stage(&root.0, "", 0, b"x", None).is_err());
        stage(&root.0, "ok", 0, b"x", None).unwrap();
        for bad in ["../outside.txt", "/abs.txt", ".zim-txn/journal.json", "a/../../b.txt"] {
            assert!(commit(&root.0, "ok", &plan(&[(bad, 0)], &[], &[])).is_err(), "{bad}");
            assert!(commit(&root.0, "ok", &plan(&[], &[bad], &[])).is_err(), "{bad}");
            assert!(commit(&root.0, "ok", &plan(&[], &[], &[("A.txt", bad)])).is_err(), "{bad}");
        }
        assert_eq!(root.files(), ["A.txt"]);
        assert_eq!(root.text("A.txt").as_deref(), Some("a"));
    }

    #[test]
    fn the_registry_lists_a_folder_once_keeps_the_list_and_knows_only_what_it_was_given() {
        let notebooks = Scratch::new();
        notebooks.put("Home.txt", "h");
        let state = Scratch::new();
        let file = state.0.join("folders.json");
        let mut registry = Registry::load(file.clone());
        assert!(registry.infos().is_empty());
        let first = registry.add(&notebooks.0).unwrap();
        let second_folder = Scratch::new();
        let second = registry.add(&second_folder.0).unwrap();
        assert_eq!(registry.infos().iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), [first.id.as_str(), second.id.as_str()], "in the order they were chosen");
        registry.forget(&second.id).unwrap();
        assert_eq!(registry.add(&notebooks.0.join(".").join("")).unwrap().id, first.id, "the same folder, whatever the way to it");
        assert_eq!(registry.infos().len(), 1);
        assert!(registry.path("0123456789abcdef").is_err());
        // it is kept
        let reloaded = Registry::load(file);
        assert_eq!(reloaded.infos(), registry.infos());
        assert_eq!(reloaded.path(&first.id).unwrap(), notebooks.0);
        // forgetting it touches nothing in it
        let mut registry = reloaded;
        registry.forget(&first.id).unwrap();
        assert!(registry.infos().is_empty());
        assert_eq!(notebooks.text("Home.txt").as_deref(), Some("h"));
        // a file is not a folder, and a folder that has gone is said to be gone
        assert!(registry.add(&notebooks.0.join("Home.txt")).is_err());
        let gone = Scratch::new();
        let info = registry.add(&gone.0).unwrap();
        let path = gone.0.clone();
        drop(gone);
        assert!(!path.exists());
        assert!(registry.path(&info.id).is_err());
        assert!(!registry.infos()[0].exists);
    }
}
