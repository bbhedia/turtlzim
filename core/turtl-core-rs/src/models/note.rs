use ::jedi::Value;
use crate::turtl::Turtl;
use crate::error::TResult;
use crate::models::model::Model;
use crate::models::validate::{self, Validate};
use crate::models::protected::{Keyfinder, Protected};
use crate::models::keychain::{Keychain, KeyRef, KeyType};
use crate::models::file::{File, FileData};
use crate::models::sync_record::{SyncRecord, SyncAction};
use crate::crypto::Key;
use crate::sync::sync_model::{self, SyncModel, MemorySaver};
#[cfg(not(target_arch = "wasm32"))]
use ::std::fs;
use crate::models::storable::Storable;

protected! {
    #[derive(Serialize, Deserialize)]
    pub struct Note {
        #[protected_field(public)]
        pub space_id: String,
        #[protected_field(public)]
        pub board_id: Option<String>,
        #[serde(with = "crate::util::ser::int_converter")]
        #[protected_field(public)]
        pub user_id: String,
        #[serde(default)]
        #[protected_field(public)]
        pub has_file: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(public, submodel)]
        pub file: Option<File>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "mod")]
        #[protected_field(public)]
        pub mod_: Option<i64>,

        #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub type_: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub tags: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub username: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub password: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub embed: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub color: Option<i64>,
        /// Whatever a client keeps about a note that no other field is for: a JSON object, encrypted with the
        /// rest of the private fields, which the core does not look into or search.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub props: Option<Value>,
    }
}

make_storable!(Note, "notes");
impl SyncModel for Note {}

impl Validate for Note {
    fn validate(&self) -> Vec<(String, String)> {
        let mut errors = Vec::new();
        if self.space_id == "" {
            errors.push(validate::entry("space_id", t!("Please add a space id to this note")));
        }
        if self.type_.as_ref().map(|x| x == "").unwrap_or(true) {
            errors.push(validate::entry("type", t!("This note is missing the `type` field")));
        }
        errors
    }
}

impl Note {
    /// Remove the files attached to this note, if any.
    #[cfg(not(target_arch = "wasm32"))]
    fn clear_files(&self, turtl: &Turtl) -> TResult<()> {
        // delete all local file(s) associated with this note (whichever user saved them: a note being
        // deleted is built from its id alone, so it doesn't know its user)
        let note_id = self.id_or_else()?;
        // (in a batch they go when the batch is kept, since a rollback brings the note back)
        if turtl.defer_file_delete(&note_id) {
            return Ok(());
        }
        let files = FileData::file_finder_all(None, Some(&note_id))?;
        for file in files {
            fs::remove_file(&file)?;
        }
        Ok(())
    }

    /// Remove the files attached to this note, if any. (On wasm32 they are rows of the user's db.)
    #[cfg(target_arch = "wasm32")]
    fn clear_files(&self, turtl: &Turtl) -> TResult<()> {
        let note_id = self.id_or_else()?;
        let mut db_guard = lock!(turtl.db);
        match db_guard.as_mut() {
            // (whichever user saved it: a note being deleted is built from its id alone, so it doesn't know its user)
            Some(db) => FileData::store_delete(db, None, Some(&note_id)),
            None => Ok(()),
        }
    }

    /// Move a note to a different space
    pub fn move_spaces(&mut self, turtl: &Turtl, new_space_id: String, new_board_id: Option<String>) -> TResult<()> {
        self.space_id = new_space_id;
        self.board_id = new_board_id;
        sync_model::save_model(SyncAction::MoveSpace, turtl, self, false)?;
        Ok(())
    }

    /// Given a Turtl/note_id, grab that note's space_id (if it exists)
    pub fn get_space_id(turtl: &Turtl, note_id: &String) -> Option<String> {
        let mut db_guard = lock!(turtl.db);
        match db_guard.as_mut() {
            Some(db) => {
                match db.get::<Self>(Self::tablename(), note_id) {
                    Ok(x) => x.map(|i| i.space_id.clone()),
                    Err(_) => None,
                }
            },
            None => None,
        }
    }
}

impl Keyfinder for Note {
    fn get_key_search(&self, turtl: &Turtl) -> TResult<Keychain> {
        let mut keychain = Keychain::new();
        let mut space_ids: Vec<String> = Vec::new();
        let mut board_ids: Vec<String> = Vec::new();
        space_ids.push(self.space_id.clone());
        if self.board_id.is_some() {
            board_ids.push(self.board_id.as_ref().expect("turtl::Note::get_key_search() -- note.board_id is None even though we just checked it hmmmmm HMMMMMMM").clone());
        }
        match self.get_keys() {
            Some(keys) => for key in keys {
                if key.ty == KeyType::Space {
                    space_ids.push(key.id.clone());
                }
                if key.ty == KeyType::Board {
                    board_ids.push(key.id.clone());
                }
            },
            None => {},
        }

        if space_ids.len() > 0 {
            let ty = String::from("space");
            let profile_guard = lockr!(turtl.profile);
            for space in &profile_guard.spaces {
                if space.id().is_none() || space.key().is_none() { continue; }
                let space_id = space.id().expect("turtl::Note::get_key_search() -- space.id() is None even though, ONCE AGAIN, we just checked for that. son of a");
                if !space_ids.contains(space_id) { continue; }
                keychain.upsert_key(turtl, space_id, space.key().expect("turtl::Note::get_key_search() -- space.key() is none"), &ty)?;
            }
        }
        if board_ids.len() > 0 {
            let ty = String::from("board");
            let profile_guard = lockr!(turtl.profile);
            for board in &profile_guard.boards {
                if board.id().is_none() || board.key().is_none() { continue; }
                let board_id = board.id().expect("turtl::Note::get_key_search() -- board.id() is none");
                if !board_ids.contains(board_id) { continue; }
                keychain.upsert_key(turtl, board_id, board.key().expect("turtl::Note::get_key_search() -- board.key() is none"), &ty)?;
            }
        }
        Ok(keychain)
    }

    fn get_keyrefs(&self, turtl: &Turtl) -> TResult<Vec<KeyRef<Key>>> {
        let mut refs: Vec<KeyRef<Key>> = Vec::new();
        let profile_guard = lockr!(turtl.profile);
        for space in &profile_guard.spaces {
            if space.id() == Some(&self.space_id) && space.key().is_some() {
                refs.push(KeyRef {
                    id: self.space_id.clone(),
                    ty: KeyType::Space,
                    k: space.key().expect("turtl::Note::get_keyrefs() -- space.key() is None GAHHH TIMMY").clone(),
                });
            }
        }

        match self.board_id {
            Some(ref board_id) => {
                for board in &profile_guard.boards {
                    if board.id() == Some(board_id) && board.key().is_some() {
                        refs.push(KeyRef {
                            id: board_id.clone(),
                            ty: KeyType::Board,
                            k: board.key().expect("turtl::Note::get_keyrefs() -- board.key() is None GAHHH TIMMY").clone(),
                        });
                    }
                }
            },
            None => {},
        }
        Ok(refs)
    }
}

impl MemorySaver for Note {
    // reindex note on add/update (reindex is idempotent)
    fn mem_update(self, turtl: &Turtl, sync_item: &mut SyncRecord) -> TResult<()> {
        let action = sync_item.action.clone();
        match action {
            SyncAction::Add | SyncAction::Edit | SyncAction::MoveSpace => {
                let note_id = match self.id() {
                    Some(x) => x.clone(),
                    // silent fail
                    None => return Ok(()),
                };
                let notes = turtl.load_notes(&vec![note_id])?;
                if notes.len() == 0 { return Ok(()); }
                let note = &notes[0];
                sync_item.data = Some(note.data()?);
                let mut search_guard = lock!(turtl.search);
                match search_guard.as_mut() {
                    Some(ref mut search) => {
                        search.reindex_note(note)?;
                    }
                    // i COULD throw an error here. i'm choosing not to...
                    None => {}
                }
            }
            SyncAction::Delete => {
                {
                    let mut search_guard = lock!(turtl.search);
                    match search_guard.as_mut() {
                        Some(ref mut search) => search.unindex_note(&self)?,
                        // i COULD throw an error here. i'm choosing not to...
                        None => {},
                    };
                }

                self.clear_files(turtl)?;
            }
            _ => {}
        }
        Ok(())
    }
}

