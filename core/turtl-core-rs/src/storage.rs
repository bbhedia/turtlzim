//! The storage module stores things. Don't worry, those things are encrypted.
//! Probably.

use ::std::sync::{Arc, RwLock};
use ::std::mem;

use crate::crypto;
use ::rusqlite::{self, Connection};
use ::jedi::{self, Value};
use ::dumpy::Dumpy;
use ::config;

use crate::models::model::{self};
use crate::models::protected::Protected;
use crate::models::storable::Storable;

use crate::error::TResult;

/// Given a db filename, return the foll path we'll use for the db file
pub fn db_location(db_name: &String) -> TResult<String> {
    if cfg!(test) {
        return Ok(String::from(":memory:"))
    }
    let data_folder = config::get::<String>(&["data_folder"])?;
    let db_location = if data_folder == ":memory:" {
        String::from(":memory:")
    } else {
        format!("{}/{}.sqlite", data_folder, db_name)
    };
    Ok(db_location)
}

/// Delete the database file at `location` (what `db_location()` gave out). Close the connection to it
/// first. `:memory:` has no file.
pub fn delete_db(location: &String) -> TResult<()> {
    if location == ":memory:" {
        return Ok(());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        info!("storage::delete_db() -- removing {}", location);
        ::std::fs::remove_file(location)?;
        Ok(())
    }
    #[cfg(target_arch = "wasm32")]
    {
        crate::wasm_host::delete_db(location.as_str())
    }
}

/// Delete every database file of ours in `data_folder` (the `turtl-*` ones: the kv store and each
/// user's).
pub fn delete_all_dbs(data_folder: &String) -> TResult<()> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use ::std::fs;
        fs::create_dir_all(data_folder)?;
        for entry in fs::read_dir(data_folder)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() { continue; }
            let filename = entry.file_name();
            let filename_str = match filename.to_str() {
                Some(x) => x,
                None => return TErr!(crate::error::TError::Msg(format!("error converting OsString into &str"))),
            };
            if &filename_str[0..6] != "turtl-" { continue; }
            fs::remove_file(&path)?;
            info!("storage::delete_all_dbs() -- removing {}", path.display());
        }
        Ok(())
    }
    #[cfg(target_arch = "wasm32")]
    {
        crate::wasm_host::delete_all_dbs(data_folder.as_str())
    }
}

/// Make sure we have a client ID, and sync it with the model system
pub fn setup_client_id(storage: Arc<RwLock<Storage>>) -> TResult<()> {
    let storage_guard = lockr!(storage);
    let conn = &storage_guard.conn;
    let dumpy = &storage_guard.dumpy;
    let id = match dumpy.kv_get(conn, "client_id")? {
        Some(x) => x,
        None => {
            let client_id = crypto::random_hash()?;
            dumpy.kv_set(conn, "client_id", &client_id)?;
            client_id
        },
    };
    model::set_client_id(id)
}

/// This structure holds state for persisting (encrypted) data to disk.
pub struct Storage {
    pub conn: Connection,
    pub dumpy: Dumpy,
}

impl Storage {
    /// Make a Storage lol
    pub fn new(location: &String, schema: Value) -> TResult<Storage> {
        // open in multi-threaded mode: we can have the same db open in multiple
        // threads as long as each thread has its own connection:
        //   https://www.sqlite.org/threadsafe.html
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE |
            rusqlite::OpenFlags::SQLITE_OPEN_CREATE |
            rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX |
            rusqlite::OpenFlags::SQLITE_OPEN_URI;
        let conn = if location == ":memory:" {
            Connection::open_in_memory_with_flags(flags)
        } else {
            Connection::open_with_flags(location, flags)
        }?;

        // set up dumpy
        let dumpy = Dumpy::new(schema);
        dumpy.init(&conn)?;

        Ok(Storage {
            conn: conn,
            dumpy: dumpy,
        })
    }

    /// Save a model to our db. Make sure it's serialized before handing it in.
    pub fn save<T>(&self, model: &T) -> TResult<()>
        where T: Protected + Storable
    {
        let modeldata = model.data_for_storage()?;
        let table = model.table();

        Ok(self.dumpy.store(&self.conn, &String::from(table), &modeldata)?)
    }

    /// Get a model's data by id
    #[allow(dead_code)]
    pub fn get<T>(&self, table: &str, id: &String) -> TResult<Option<T>>
        where T: Protected + Storable
    {
        match self.dumpy.get(&self.conn, &String::from(table), id) {
            Ok(x) => match x {
                Some(x) => {
                    let res = match jedi::from_val(x) {
                        Ok(x) => x,
                        Err(e) => return Err(From::from(e)),
                    };
                    Ok(Some(res))
                }
                None => Ok(None),
            },
            Err(e) => Err(From::from(e)),
        }
    }

    /// Delete a model from storage
    pub fn delete<T>(&self, model: &T) -> TResult<()>
        where T: Protected + Storable
    {
        let id = model.id_or_else()?;
        let table = model.table();
        Ok(self.dumpy.delete(&self.conn, &String::from(table), &id)?)
    }

    /// Grab all values from a "table" ordered by id ASC, w/ a result limit
    pub fn all_limit<T>(&self, table: &str, limit: Option<i32>) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        Ok(jedi::from_val(Value::Array(self.dumpy.all_limit(&self.conn, &String::from(table), limit)?))?)
    }

    /// Grab all values from a "table" ordered by id ASC
    pub fn all<T>(&self, table: &str) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        self.all_limit(table, None)
    }

    /// Find values by index/value in a "table"
    pub fn find<T>(&self, table: &str, index: &str, vals: &Vec<String>) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        Ok(jedi::from_val(Value::Array(self.dumpy.find(&self.conn, &String::from(table), &String::from(index), vals)?))?)
    }

    /// Get ALL objects in a table with the given IDs
    pub fn by_id<T>(&self, table: &str, ids: &Vec<String>) -> TResult<Vec<T>>
        where T: Protected + Storable
    {
        Ok(jedi::from_val(Value::Array(self.dumpy.by_id(&self.conn, &String::from(table), &ids)?))?)
    }

    /// Grab a value from our dumpy k/v store
    pub fn kv_get(&self, key: &str) -> TResult<Option<String>> {
        Ok(self.dumpy.kv_get(&self.conn, key)?)
    }

    /// Set a value into our dumpy k/v store
    pub fn kv_set(&self, key: &str, val: &String) -> TResult<()> {
        Ok(self.dumpy.kv_set(&self.conn, key, val)?)
    }

    pub fn kv_delete(&self, key: &str) -> TResult<()> {
        Ok(self.dumpy.kv_delete(&self.conn, key)?)
    }

    /// Make sure the table that holds attachments exists. (Made on first use, not by the dumpy schema:
    /// only builds that keep attachments in the database need it, see `FileData::store_put`.)
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn ensure_attachments_table(&self) -> TResult<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS attachments (user_id TEXT NOT NULL, note_id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (user_id, note_id))",
            [],
        )?;
        Ok(())
    }

    /// Store the (encrypted) file of a note, replacing any it has.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub fn attachment_put(&self, user_id: &String, note_id: &String, data: &[u8]) -> TResult<()> {
        self.ensure_attachments_table()?;
        self.conn.execute(
            "INSERT OR REPLACE INTO attachments (user_id, note_id, data) VALUES (?1, ?2, ?3)",
            rusqlite::params![user_id, note_id, data],
        )?;
        Ok(())
    }

    /// The stored file of a note: any user's if `user_id` is None.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub fn attachment_get(&self, user_id: Option<&String>, note_id: &String) -> TResult<Option<Vec<u8>>> {
        self.ensure_attachments_table()?;
        let res = self.conn.query_row(
            "SELECT data FROM attachments WHERE note_id = ?1 AND (?2 IS NULL OR user_id = ?2) LIMIT 1",
            rusqlite::params![note_id, user_id],
            |row| row.get::<_, Vec<u8>>(0),
        );
        match res {
            Ok(data) => Ok(Some(data)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(From::from(e)),
        }
    }

    /// Delete stored files. `None` matches any user, or any note.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub fn attachment_delete(&self, user_id: Option<&String>, note_id: Option<&String>) -> TResult<()> {
        self.ensure_attachments_table()?;
        self.conn.execute(
            "DELETE FROM attachments WHERE (?1 IS NULL OR user_id = ?1) AND (?2 IS NULL OR note_id = ?2)",
            rusqlite::params![user_id, note_id],
        )?;
        Ok(())
    }

    /// Close the db connection
    pub fn close(&mut self) -> TResult<()> {
        let mut conn = Connection::open_in_memory()?;
        mem::swap(&mut self.conn, &mut conn);
        conn.close()?;
        Ok(())
    }
}

// NOTE: since we open our db connection in full-mutex mode, we can safely pass
// it around between threads willy-nilly.
unsafe impl Sync for Storage {}

#[cfg(test)]
mod tests {
    use super::*;

    use ::jedi::{self, Value};
    use ::rusqlite::types::Value as SqlValue;

    use crate::error::TResult;
    use crate::models::model::{self, Model};
    use crate::models::protected::Protected;

    // On wasm32 these run under `wasm-pack test --node` against real SQLite (sqlite-wasm-rs):
    // wasm-bindgen-test's attribute shadows `#[test]`, and the tests that need real crypto go
    // through the crate-wide `crypto_test!` (crypto/mod.rs), because libsodium.js needs a
    // one-time async init first.
    #[cfg(target_arch = "wasm32")]
    use ::wasm_bindgen_test::wasm_bindgen_test as test;

    protected! {
        #[derive(Serialize, Deserialize)]
        pub struct Shiba {
            #[protected_field(public)]
            pub color: Option<String>,

            #[protected_field(private)]
            pub name: Option<String>,
            #[protected_field(private)]
            pub tags: Option<Vec<String>>,
        }
    }
    make_storable!(Shiba, "shibas");

    fn pretest() -> Storage {
        model::set_client_id(String::from("c0f4c762af6c42e4079cced2dfe16b4d010b190ad75ade9d83ff8cee0e96586d")).unwrap();
        let schema_str = r#"{"notes":{"indexes":[{"fields":["user_id"]},{"fields":["boards"]}]}}"#;
        let schema: Value = jedi::parse(&String::from(schema_str)).unwrap();
        Storage::new(&String::from(":memory:"), schema).unwrap()
    }

    #[test]
    fn stores_attachments() {
        let storage = pretest();
        let (u1, u2, note) = (String::from("u1"), String::from("u2"), String::from("n1"));
        assert_eq!(storage.attachment_get(None, &note).unwrap(), None);

        // bytes that aren't text survive, and a second put replaces the first
        storage.attachment_put(&u1, &note, &[0, 1, 255, 254]).unwrap();
        assert_eq!(storage.attachment_get(Some(&u1), &note).unwrap(), Some(vec![0, 1, 255, 254]));
        storage.attachment_put(&u1, &note, &[9, 9]).unwrap();
        assert_eq!(storage.attachment_get(None, &note).unwrap(), Some(vec![9, 9]));
        // another user's file for the same note is a different file
        storage.attachment_put(&u2, &note, &[7]).unwrap();
        assert_eq!(storage.attachment_get(Some(&u2), &note).unwrap(), Some(vec![7]));
        assert_eq!(storage.attachment_get(Some(&u1), &note).unwrap(), Some(vec![9, 9]));

        // deleting by user, then by note
        storage.attachment_delete(Some(&u2), None).unwrap();
        assert_eq!(storage.attachment_get(Some(&u2), &note).unwrap(), None);
        assert_eq!(storage.attachment_get(Some(&u1), &note).unwrap(), Some(vec![9, 9]));
        storage.attachment_delete(None, Some(&note)).unwrap();
        assert_eq!(storage.attachment_get(None, &note).unwrap(), None);
    }

    #[test]
    fn runs_queries() {
        // `&[]` no longer type-infers as a param list, and `Row::get_checked`
        // was renamed to `get` in the rusqlite version this now resolves to.
        let storage = pretest();
        storage.conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name VARCHAR(16))", []).unwrap();
        storage.conn.execute("INSERT INTO test (name) VALUES ($1)", &[&String::from("bartholomew")]).unwrap();
        let then = "SELECT * FROM test LIMIT 1";
        let res = storage.conn.query_row_and_then(then, [], |row| -> TResult<String> {
            let name_sql: SqlValue = row.get("name").unwrap();
            match name_sql {
                SqlValue::Text(ref x) => Ok(x.clone()),
                _ => panic!("bad dates (name field was not a string)"),
            }
        }).unwrap();
        assert_eq!(res, "bartholomew");
    }

    fn saves_retrieves_models_body() {
        let storage = pretest();
        let mut model = Shiba::new_with_id().unwrap();
        let key = model.generate_key().unwrap().clone();
        model.color = Some(String::from("sesame"));
        model.name = Some(String::from("Kofi"));
        model.tags = Some(vec![String::from("serious")]);
        model.serialize().unwrap();
        storage.save(&model).unwrap();

        let id = model.id().unwrap();
        let mut shiba2: Shiba = storage.get("shibas", id).unwrap().unwrap();
        shiba2.set_key(Some(key));
        shiba2.deserialize().unwrap();
        assert_eq!(shiba2.color.unwrap(), String::from("sesame"));
        assert_eq!(shiba2.name.unwrap(), String::from("Kofi"));
        assert_eq!(shiba2.tags.unwrap(), vec![String::from("serious")]);

        assert_eq!(storage.all::<Shiba>("shibas").unwrap().len(), 1);
    }

    fn deletes_models_body() {
        let storage = pretest();
        let mut model = Shiba::new_with_id().unwrap();
        model.generate_key().unwrap();
        model.color = Some(String::from("sesame"));
        model.name = Some(String::from("Kofi"));
        model.tags = Some(vec![String::from("serious")]);
        model.serialize().unwrap();
        storage.save(&model).unwrap();

        storage.delete(&model).unwrap();

        let id = model.id().unwrap();
        let sheeb: Option<Shiba> = storage.get("shibas", id).unwrap();
        assert!(sheeb.is_none());
    }

    #[test]
    fn kv_stuff() {
        // ^kv stuff? were the midterms hard?
        let storage = pretest();
        assert_eq!(storage.kv_get("get a job").unwrap(), None);
        storage.kv_set("get a job", &String::from("no way")).unwrap();
        assert_eq!(storage.kv_get("get a job").unwrap().unwrap(), "no way");
        storage.kv_delete("get a job").unwrap();
        assert_eq!(storage.kv_get("get a job").unwrap(), None);
    }

    crypto_test!(saves_retrieves_models, saves_retrieves_models_body);
    crypto_test!(deletes_models, deletes_models_body);
}

