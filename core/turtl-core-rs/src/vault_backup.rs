//! A backup of the vault of a core without a server, and putting one back.
//!
//! A backup is everything that is kept for the account, as it is kept, in one file: the account's record, the rows of
//! the user's database (the keys of the notebooks, the notebooks, their pages) and the files of the pages. Nothing is
//! opened or sealed again to make it, so it holds no more than the browser's own files hold, and it is opened with the
//! passphrase the vault had when it was made (a passphrase changed since opens the vault, not the backup). That makes
//! it a safe copy, and a way to move the vault to another computer until there is a sync: restored there, it is the
//! vault, and the two go their own ways from then on.
//!
//! ```text
//! "ZIMVAULT"  the format (u16, now 1)
//! then records, each one: kind (u8)  length (u32)  that many bytes
//!   1  account   JSON {"name": ..., "record": ...}                  one, the first
//!   2  row       JSON {"table": ..., "row": {...}}                  one for each row of the tables below
//!   3  file      length of the note's id (u16)  the id  the file as it is kept (sealed)
//!   255 end      SHA-256 of every byte before this record           the last, and nothing comes after it
//! ```
//!
//! (All numbers are big endian.) The sum at the end is for what goes wrong by accident: a file that was cut short, or a
//! byte that was changed on the way. It can't tell a file that someone made on purpose from one that is real: that is
//! what the passphrase is for, since a vault opens only with its own, and everything in it is sealed.
//!
//! Restoring checks the whole file before it writes anything, writes the database in one transaction, and writes the
//! account's record last, since it is the account's record that makes a vault exist: a restore that is stopped leaves
//! none.
use ::std::collections::HashSet;
use ::std::convert::TryFrom;
use ::jedi::{self, Value};
use crate::crypto;
use crate::error::{TResult, TError};
use crate::models::file::FileData;
use crate::models::user::{self, LocalAccount, MAX_KDF_MEM, MAX_KDF_OPS};
use crate::schema;
use crate::storage::{self, Storage};
use crate::turtl::Turtl;

const MAGIC: &[u8] = b"ZIMVAULT";
const FORMAT: u16 = 1;
const ACCOUNT: u8 = 1;
const ROW: u8 = 2;
const FILE: u8 = 3;
const END: u8 = 255;

/// The tables of the user's database that are kept in a backup. (The others are for a core with a server: what is waiting to
/// be synced, and what an account on one has.)
const TABLES: &[&str] = &["keychain", "spaces", "boards", "notes", "invites", "users"];

/// The most a backup may be, to be restored (a core holds all of it in memory while it does).
pub(crate) const MAX_BACKUP_BYTES: usize = 1 << 30;

/// What a backup is made of, apart from how it is written down.
#[derive(Debug, PartialEq)]
pub(crate) struct Backup {
    /// The account's name: what its record is kept under.
    pub name: String,
    /// The account's record, as it is kept.
    pub record: Value,
    /// The rows of the user's database: the table, and the row as it is stored.
    pub rows: Vec<(String, Value)>,
    /// The files of the notes: the note's id, and the file as it is kept (sealed).
    pub files: Vec<(String, Vec<u8>)>,
}

/// A backup of this many bytes can be made, and restored. (One that could not be restored is no backup.)
fn check_size(bytes: usize) -> TResult<()> {
    if bytes > MAX_BACKUP_BYTES {
        return TErr!(TError::BadValue(format!("the encrypted notebooks hold more than {} MiB: that is too much for a backup", MAX_BACKUP_BYTES >> 20)));
    }
    Ok(())
}

fn bad_backup<T>(what: &str) -> TResult<T> {
    TErr!(TError::BadValue(format!("the backup can't be restored: {}", what)))
}

/// One record: its kind, its length, and its parts one after the other.
fn put_record(out: &mut Vec<u8>, kind: u8, parts: &[&[u8]]) -> TResult<()> {
    let length: usize = parts.iter().map(|part| part.len()).sum();
    let length = match u32::try_from(length) {
        Ok(length) => length,
        Err(_) => return TErr!(TError::BadValue(String::from("a part of the backup would be more than 4 GiB: it is too big for one"))),
    };
    out.push(kind);
    out.extend_from_slice(&length.to_be_bytes());
    for part in parts {
        out.extend_from_slice(part);
    }
    Ok(())
}

/// The string at `key` of a JSON object.
fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|text| text.as_str())
}

/// Whether `id` is what the core makes ids of: it becomes part of the name of a file, so nothing else will do.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Backup {
    /// The backup as a file.
    pub fn write(&self) -> TResult<Vec<u8>> {
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&FORMAT.to_be_bytes());
        let account = jedi::stringify(&json!({"name": self.name, "record": self.record}))?;
        put_record(&mut out, ACCOUNT, &[account.as_bytes()])?;
        for (table, row) in &self.rows {
            let row = jedi::stringify(&json!({"table": table, "row": row}))?;
            put_record(&mut out, ROW, &[row.as_bytes()])?;
        }
        for (note_id, file) in &self.files {
            let id_length = match u16::try_from(note_id.len()) {
                Ok(length) => length,
                Err(_) => return TErr!(TError::BadValue(String::from("a note's id is too long"))),
            };
            put_record(&mut out, FILE, &[&id_length.to_be_bytes(), note_id.as_bytes(), file])?;
        }
        let sum = crypto::sha256(&out)?;
        put_record(&mut out, END, &[&sum])?;
        Ok(out)
    }

    /// A backup, from a file. Everything about it is checked: how it is written down (where each record starts and ends, and
    /// that the sum at the end is the sum of what is before), what it holds (known tables, an id for every row, no row twice, a file only
    /// for a note that is there).
    pub fn read(bytes: &[u8]) -> TResult<Backup> {
        if bytes.len() < MAGIC.len() + 2 || &bytes[..MAGIC.len()] != MAGIC {
            return bad_backup("it does not start as one does");
        }
        let format = u16::from_be_bytes([bytes[MAGIC.len()], bytes[MAGIC.len() + 1]]);
        if format != FORMAT {
            return bad_backup(&format!("it is of a format (number {}) that this version of the app does not know", format));
        }
        let mut backup: Option<Backup> = None;
        let mut at = MAGIC.len() + 2;
        loop {
            if bytes.len() - at < 5 {
                return bad_backup("it ends in the middle of a record");
            }
            let kind = bytes[at];
            let length = u32::from_be_bytes([bytes[at + 1], bytes[at + 2], bytes[at + 3], bytes[at + 4]]) as usize;
            let start = at + 5;
            if length > bytes.len() - start {
                return bad_backup("it ends in the middle of a record");
            }
            let payload = &bytes[start..start + length];
            match (kind, backup.as_mut()) {
                (ACCOUNT, None) => {
                    let parsed: Value = match ::std::str::from_utf8(payload).ok().and_then(|text| jedi::parse(&String::from(text)).ok()) {
                        Some(parsed) => parsed,
                        None => return bad_backup("its account can't be read"),
                    };
                    let name = match text_of(&parsed, "name") {
                        Some(name) => String::from(name),
                        None => return bad_backup("its account has no name"),
                    };
                    let record = match parsed.get("record") {
                        Some(record) if record.is_object() => record.clone(),
                        _ => return bad_backup("its account has no record"),
                    };
                    backup = Some(Backup { name: name, record: record, rows: Vec::new(), files: Vec::new() });
                }
                (ACCOUNT, Some(_)) => return bad_backup("it has more than one account"),
                (_, None) => return bad_backup("it does not begin with the account"),
                (ROW, Some(backup)) => {
                    let parsed: Value = match ::std::str::from_utf8(payload).ok().and_then(|text| jedi::parse(&String::from(text)).ok()) {
                        Some(parsed) => parsed,
                        None => return bad_backup("a row can't be read"),
                    };
                    let table = match text_of(&parsed, "table") {
                        Some(table) if TABLES.contains(&table) => String::from(table),
                        _ => return bad_backup("a row is of a table that a backup does not hold"),
                    };
                    match parsed.get("row") {
                        Some(row) if row.is_object() && text_of(row, "id").map(|id| !id.is_empty()).unwrap_or(false) => backup.rows.push((table, row.clone())),
                        _ => return bad_backup("a row has no id"),
                    }
                }
                (FILE, Some(backup)) => {
                    if payload.len() < 2 {
                        return bad_backup("a file has no note");
                    }
                    let id_length = u16::from_be_bytes([payload[0], payload[1]]) as usize;
                    if payload.len() < 2 + id_length {
                        return bad_backup("a file's note can't be read");
                    }
                    let id = match ::std::str::from_utf8(&payload[2..2 + id_length]) {
                        Ok(id) => String::from(id),
                        Err(_) => return bad_backup("a file's note can't be read"),
                    };
                    backup.files.push((id, payload[2 + id_length..].to_vec()));
                }
                (END, Some(_)) => {
                    if length != 32 || start + length != bytes.len() {
                        return bad_backup("it has more after its end");
                    }
                    if crypto::sha256(&bytes[..at])?.as_slice() != payload {
                        return bad_backup("it is damaged: what it adds up to is not what was written at its end (it was cut short, or a byte was changed)");
                    }
                    let backup = backup.expect("a backup has its account by its end");
                    backup.check_whole()?;
                    return Ok(backup);
                }
                _ => return bad_backup("it has a record of a kind this version of the app does not know"),
            }
            at = start + length;
        }
    }

    /// What a backup's rows and files have to be for it to be one.
    fn check_whole(&self) -> TResult<()> {
        let mut rows: HashSet<(&str, &str)> = HashSet::new();
        for (table, row) in &self.rows {
            let id = text_of(row, "id").unwrap_or("");
            if !rows.insert((table.as_str(), id)) {
                return bad_backup("a row is there twice");
            }
        }
        let mut files: HashSet<&str> = HashSet::new();
        for (note_id, _) in &self.files {
            if !is_safe_id(note_id) {
                return bad_backup("a file is of a note whose id is not one");
            }
            if !files.insert(note_id.as_str()) {
                return bad_backup("a file is there twice");
            }
            if !rows.contains(&("notes", note_id.as_str())) {
                return bad_backup("a file belongs to a note that is not there");
            }
        }
        Ok(())
    }

    /// How many notebooks, pages and files it holds (what a person is told it restored).
    pub fn counts(&self) -> Value {
        let in_table = |table: &str| self.rows.iter().filter(|(name, _)| name == table).count();
        json!({"spaces": in_table("spaces"), "notes": in_table("notes"), "files": self.files.len()})
    }
}

/// The account's record, checked as what a core without a server can make an account of: a name that is safe to keep it
/// under, an id that is a number (a user's database is named after it), costs a device can bear, and a record that is a record.
fn checked_account(backup: &Backup) -> TResult<LocalAccount> {
    let name = &backup.name;
    if name.is_empty() || name.len() > 128 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.' || b == b'@') {
        return bad_backup("its account has a name that an account can't have");
    }
    let record: LocalAccount = match jedi::from_val(backup.record.clone()) {
        Ok(record) => record,
        Err(_) => return bad_backup("its account's record is not one"),
    };
    if record.id.is_empty() || record.id.len() > 20 || !record.id.bytes().all(|b| b.is_ascii_digit()) {
        return bad_backup("its account has an id that is not a number");
    }
    for kdf in ::std::iter::once(&record.kdf).chain(record.pending.as_ref().map(|pending| &pending.kdf)) {
        if kdf.mem > MAX_KDF_MEM || kdf.ops > MAX_KDF_OPS {
            return bad_backup("its account asks for more to unlock than a device can give");
        }
    }
    if !record.data.is_object() {
        return bad_backup("its account has no user record");
    }
    Ok(record)
}

/// Make a backup of the vault `turtl` is logged into, as a file.
pub(crate) fn make(turtl: &Turtl) -> TResult<Vec<u8>> {
    if !turtl.local_only {
        return TErr!(TError::PermissionDenied(String::from("only a core without a server keeps a vault to back up")));
    }
    let user_id = turtl.user_id()?;
    let name = lockr!(turtl.user).username.clone();
    let record: Value = {
        let kv_guard = lockr!(turtl.kv);
        match kv_guard.kv_get(&user::local_account_key(&name))? {
            Some(stored) => jedi::parse(&stored)?,
            None => return TErr!(TError::NotFound(String::from("the account of this vault is not on this device"))),
        }
    };
    let mut backup = Backup { name: name, record: record, rows: Vec::new(), files: Vec::new() };
    let mut db_guard = lock!(turtl.db);
    let db = match db_guard.as_mut() {
        Some(db) => db,
        None => return TErr!(TError::MissingField(String::from("Turtl.db"))),
    };
    if db.in_batch() {
        return TErr!(TError::BadValue(String::from("a batch of changes is open: it has to be kept or undone first")));
    }
    for table in TABLES {
        for row in db.all_values(table)? {
            backup.rows.push((String::from(*table), row));
        }
    }
    let note_ids: Vec<String> = backup.rows.iter().filter(|(table, _)| table == "notes").filter_map(|(_, row)| text_of(row, "id").map(String::from)).collect();
    for note_id in note_ids {
        match FileData::store_get(db, Some(&user_id), &note_id) {
            Ok(file) => backup.files.push((note_id, file)),
            Err(e) => match e.shed() {
                // (a note has a file or it doesn't)
                TError::NotFound(_) => {}
                other => return Err(other),
            },
        }
    }
    // (the files are most of it: they are counted before everything is put together)
    check_size(backup.files.iter().map(|(_, file)| file.len()).sum())?;
    let bytes = backup.write()?;
    check_size(bytes.len())?;
    Ok(bytes)
}

/// Put a backup back: the account and everything of it, on a core that has no account and nobody logged in.
/// Says how much it restored.
pub(crate) fn restore(turtl: &Turtl, bytes: &[u8]) -> TResult<Value> {
    if !turtl.local_only {
        return TErr!(TError::PermissionDenied(String::from("only a core without a server keeps a vault")));
    }
    if lockr!(turtl.user).logged_in {
        return TErr!(TError::BadValue(String::from("a vault can't be restored while one is unlocked")));
    }
    // all of it is checked before anything is written
    let backup = Backup::read(bytes)?;
    let record = checked_account(&backup)?;
    if !user::User::local_accounts(turtl)?.is_empty() {
        return TErr!(TError::Api(crate::api::StatusCode::CONFLICT, json!({"error": "there are already encrypted notebooks on this device: a backup is restored where there are none"})));
    }

    let location = turtl.get_user_db_location(&record.id)?;
    let mut db = Storage::new(&location, schema::get_schema())?;
    let mut written_files: Vec<String> = Vec::new();
    let written = (|| -> TResult<()> {
        db.begin()?;
        for (table, row) in &backup.rows {
            db.store_value(table, row)?;
        }
        for (note_id, file) in &backup.files {
            FileData::store_put(&mut db, &record.id, note_id, file)?;
            written_files.push(note_id.clone());
        }
        db.commit()
    })();
    if let Err(e) = written {
        // nothing of it is kept: the transaction is undone, and what was written outside of it is taken away
        let _ = db.rollback();
        for note_id in &written_files {
            let _ = FileData::store_delete(&mut db, Some(&record.id), Some(note_id));
        }
        let _ = db.close();
        let _ = storage::delete_db(&location);
        return Err(e);
    }
    db.close()?;

    // the account, last: it is what makes a vault exist
    let kv_guard = lockw!(turtl.kv);
    kv_guard.kv_set(&user::local_account_key(&backup.name), &jedi::stringify(&record)?)?;
    Ok(backup.counts())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_backup() -> Backup {
        Backup {
            name: String::from("a-vault"),
            record: json!({"id": "123456", "auth": "00aa", "kdf": {"ops": 4194304, "mem": 134217728}, "data": {"username": "a-vault", "body": "AAYB"}}),
            rows: vec![
                (String::from("keychain"), json!({"id": "k1", "body": "AAYBAAz1"})),
                (String::from("spaces"), json!({"id": "s1", "body": "AAYBAAz2", "user_id": 123456})),
                (String::from("notes"), json!({"id": "n1", "body": "AAYBAAz3", "space_id": "s1", "has_file": true})),
                (String::from("notes"), json!({"id": "n2", "body": "AAYBAAz4", "space_id": "s1"})),
            ],
            files: vec![(String::from("n1"), vec![0u8, 1, 2, 255, 254, 0, 0, 7])],
        }
    }

    crypto_test!(a_backup_comes_back_as_it_was_written, a_backup_comes_back_as_it_was_written_body);
    fn a_backup_comes_back_as_it_was_written_body() {
        let backup = a_backup();
        let bytes = backup.write().unwrap();
        assert_eq!(&bytes[..8], b"ZIMVAULT");
        assert_eq!(&bytes[8..10], &[0, 1]);
        assert_eq!(Backup::read(&bytes).unwrap(), backup);
        assert_eq!(backup.counts(), json!({"spaces": 1, "notes": 2, "files": 1}));
        // (written twice it is the same file: nothing in it is made up as it goes, like a time or a random number)
        assert_eq!(a_backup().write().unwrap(), bytes);
        // and a vault that has nothing in it yet is a backup too
        let empty = Backup { name: String::from("a-vault"), record: backup.record.clone(), rows: Vec::new(), files: Vec::new() };
        assert_eq!(Backup::read(&empty.write().unwrap()).unwrap(), empty);
    }

    crypto_test!(whatever_is_wrong_with_a_file_is_refused, whatever_is_wrong_with_a_file_is_refused_body);
    fn whatever_is_wrong_with_a_file_is_refused_body() {
        let good = a_backup().write().unwrap();
        let refused = |bytes: &[u8], why: &str| {
            let error = Backup::read(bytes).unwrap_err().to_string();
            assert!(error.contains(why), "expected {:?}, got {:?}", why, error);
        };
        refused(b"", "does not start");
        refused(b"ZIMVAUL", "does not start");
        refused(b"%PDF-1.4 and some more bytes", "does not start");
        let mut newer = good.clone();
        newer[9] = 2;
        refused(&newer, "format (number 2)");
        // cut short at every length: never read, and never a panic
        for length in 0..good.len() {
            assert!(Backup::read(&good[..length]).is_err(), "a file cut to {} bytes was read", length);
        }
        // one byte changed, anywhere: never read as it is, and never a panic (the sum at the end sees what the checks of the records don't)
        for at in 0..good.len() {
            let mut changed = good.clone();
            changed[at] ^= 0x40;
            match Backup::read(&changed) {
                Err(_) => {}
                Ok(read) => panic!("a file with byte {} changed was read: {:?}", at, read),
            }
        }
        // something after the end
        let mut more = good.clone();
        more.push(0);
        refused(&more, "more after its end");
        // a damaged file with its sum made again is a file somebody made: what is checked is what it holds
        let remade = |edit: &dyn Fn(&mut Vec<u8>)| -> Vec<u8> {
            let mut bytes = good[..good.len() - 5 - 32].to_vec();
            edit(&mut bytes);
            let sum = crypto::sha256(&bytes).unwrap();
            put_record(&mut bytes, END, &[&sum]).unwrap();
            bytes
        };
        let unchanged = remade(&|_| {});
        assert_eq!(unchanged, good, "(the way a file is made again is the way it is made)");
        // a second account
        let second = a_backup().write().unwrap();
        let account_record_end = 10 + 5 + u32::from_be_bytes([second[11], second[12], second[13], second[14]]) as usize;
        refused(&remade(&|bytes| { let account = second[10..account_record_end].to_vec(); bytes.extend_from_slice(&account); }), "more than one account");
        // no account first
        refused(&remade(&|bytes| { bytes.drain(10..account_record_end); }), "does not begin with the account");
        // a record of a kind there is not
        refused(&remade(&|bytes| put_record(bytes, 9, &[b"x"]).unwrap()), "kind this version");
        // a row of a table that a backup does not hold, a row with no id, a row that is not a row
        refused(&remade(&|bytes| put_record(bytes, ROW, &[br#"{"table":"sync","row":{"id":"x"}}"#]).unwrap()), "table that a backup does not hold");
        refused(&remade(&|bytes| put_record(bytes, ROW, &[br#"{"table":"notes","row":{"body":"x"}}"#]).unwrap()), "has no id");
        refused(&remade(&|bytes| put_record(bytes, ROW, &[br#"{"table":"notes","row":"x"}"#]).unwrap()), "has no id");
        refused(&remade(&|bytes| put_record(bytes, ROW, &[b"not json {"]).unwrap()), "can't be read");
        refused(&remade(&|bytes| put_record(bytes, ROW, &[&[0xff, 0xfe, 0xfd]]).unwrap()), "can't be read");
        // a row twice
        refused(&remade(&|bytes| put_record(bytes, ROW, &[br#"{"table":"notes","row":{"id":"n2"}}"#]).unwrap()), "there twice");
        // files: with no note, for a note that isn't there, twice, of a note whose id would be a path
        refused(&remade(&|bytes| put_record(bytes, FILE, &[&[0u8]]).unwrap()), "has no note");
        refused(&remade(&|bytes| put_record(bytes, FILE, &[&[0u8, 9], b"abc"]).unwrap()), "can't be read");
        refused(&remade(&|bytes| put_record(bytes, FILE, &[&[0u8, 2], b"zz", b"data"]).unwrap()), "not there");
        refused(&remade(&|bytes| put_record(bytes, FILE, &[&[0u8, 2], b"n1", b"data"]).unwrap()), "file is there twice");
        refused(&remade(&|bytes| put_record(bytes, FILE, &[&[0u8, 6], b"../n_1", b"data"]).unwrap()), "not one");
        // the end where it should not be (the sum is of everything before it, so a record after it breaks it)
        let mut early = good[..good.len() - 5 - 32].to_vec();
        let sum = crypto::sha256(&early).unwrap();
        put_record(&mut early, END, &[&sum]).unwrap();
        put_record(&mut early, ROW, &[br#"{"table":"notes","row":{"id":"n3"}}"#]).unwrap();
        refused(&early, "more after its end");
    }

    #[test]
    fn a_backup_is_no_bigger_than_can_be_restored() {
        assert!(check_size(0).is_ok());
        assert!(check_size(MAX_BACKUP_BYTES).is_ok());
        assert!(check_size(MAX_BACKUP_BYTES + 1).unwrap_err().to_string().contains("too much for a backup"));
    }

    #[test]
    fn what_an_account_may_be() {
        let ok = a_backup();
        assert!(checked_account(&ok).is_ok());
        let with = |edit: &dyn Fn(&mut Backup)| {
            let mut backup = a_backup();
            edit(&mut backup);
            checked_account(&backup).map(|_| ()).unwrap_err().to_string()
        };
        for name in &["", "has a space", "a/b", "../x", "with:colon", &"x".repeat(129)] {
            assert!(with(&|b| b.name = String::from(*name)).contains("name that an account can't have"), "{:?}", name);
        }
        for id in &["", "abc", "12 3", "../1", "123456789012345678901", "-1"] {
            assert!(with(&|b| b.record["id"] = json!(id)).contains("not a number"), "{:?}", id);
        }
        assert!(with(&|b| b.record["kdf"] = json!({"ops": 1u64 << 40, "mem": 134217728})).contains("for more to unlock"));
        assert!(with(&|b| b.record["kdf"] = json!({"ops": 4194304, "mem": (1u64 << 30) + 1})).contains("for more to unlock"));
        assert!(with(&|b| b.record["pending"] = json!({"auth": "x", "kdf": {"ops": 4194304, "mem": 1u64 << 40}, "data": {}, "new_under_old": "a", "old_under_new": "b"})).contains("for more to unlock"));
        assert!(with(&|b| b.record["data"] = json!("text")).contains("no user record"));
        assert!(with(&|b| { b.record.as_object_mut().unwrap().remove("auth"); }).contains("is not one"));
        // an account kept before its cost was kept with it has none, and is an account all the same
        let mut old = a_backup();
        old.record.as_object_mut().unwrap().remove("kdf");
        assert!(checked_account(&old).is_ok());
    }
}
