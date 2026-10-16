use ::std::collections::HashMap;
use ::jedi::{self, Value, Serialize};
use crate::error::{TResult, TError};
use crate::crypto::{self, Key, CryptoOp};
use crate::api::{ApiReq, StatusCode};
use crate::models::model::{self, Model};
use crate::models::space::Space;
use crate::models::board::Board;
use crate::models::protected::{self, Keyfinder, Protected};
use crate::models::keychain::KeychainEntry;
use crate::models::storable::Storable;
use crate::storage::Storage;
use crate::models::sync_record::{SyncType, SyncAction, SyncRecord};
use crate::models::validate::{self, Validate};
use crate::turtl::Turtl;
#[cfg(not(target_arch = "wasm32"))]
use crate::util;
use crate::util::exec;
use crate::sync::sync_model::{self, SyncModel, MemorySaver};
use crate::sync::incoming::SyncIncoming;
use crate::messaging;
#[cfg(not(target_arch = "wasm32"))]
use ::migrate::MigrateResult;
// TODO(wasm): see turtl.rs's `MigrateResult` stub -- same rationale (the `migrate` crate isn't
// a wasm32 dependency; docs/wasm-port-plan.md).
#[cfg(target_arch = "wasm32")]
use crate::turtl::MigrateResult;
#[cfg(not(target_arch = "wasm32"))]
use ::std::path::PathBuf;
#[cfg(not(target_arch = "wasm32"))]
use ::std::io::prelude::*;
#[cfg(not(target_arch = "wasm32"))]
use ::std::fs;

pub const CURRENT_AUTH_VERSION: u16 = 0;
lazy_static! {
    // this is the key used to encrypt login tokens. it's not meant as a real
    // protection as much as it is a deterrent for lazy attackers
    static ref TOKEN_KEY: Key = Key::new(vec![33, 98, 95, 119, 236, 248, 150, 31, 91, 187, 94, 119, 18, 81, 190, 80, 46, 249, 173, 255, 214, 194, 176, 88, 197, 208, 38, 234, 144, 33, 144, 52]);
}

protected! {
    #[derive(Serialize, Deserialize)]
    pub struct User {
        #[serde(skip)]
        pub auth: Option<String>,
        #[serde(skip)]
        pub logged_in: bool,

        #[protected_field(public)]
        pub username: String,

        #[serde(default)]
        #[protected_field(public)]
        pub confirmed: bool,

        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(public)]
        pub name: Option<String>,

        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(public)]
        pub pubkey: Option<Key>,

        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub settings: Option<HashMap<String, Value>>,

        #[serde(skip_serializing_if = "Option::is_none")]
        #[protected_field(private)]
        pub privkey: Option<Key>,
    }
}

/// What it costs to try a passphrase: the limits of the scrypt that turns it into a key (libsodium's
/// `opslimit` and `memlimit`; the cost is mostly the memory, which is what makes guessing in bulk dear).
/// An account on a server has the cost every Turtl account has ever had (`Default`); one that lives on this
/// device alone has no server to slow guesses down, and is within reach of whoever gets at the browser's
/// storage, so it is made with `Kdf::local()` and keeps the cost it was made with.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Kdf {
    pub(crate) ops: usize,
    pub(crate) mem: usize,
}

impl Default for Kdf {
    fn default() -> Kdf {
        Kdf { ops: crypto::KEYGEN_OPS_DEFAULT, mem: crypto::KEYGEN_MEM_DEFAULT }
    }
}

/// The most a stored cost may ask of a device (see `login_local`): eight times what a vault is made at, in
/// memory (a gigabyte) and in work.
pub(crate) const MAX_KDF_MEM: usize = 1 << 30;
pub(crate) const MAX_KDF_OPS: usize = 1 << 25;

impl Kdf {
    /// scrypt with N = 2^17, r = 8, p = 1: 128 MiB, eight times the work of the default, which is about
    /// as much memory as a wasm instance in a browser can be asked for without risk (libsodium's
    /// "sensitive" level is 1 GiB).
    fn local() -> Kdf {
        Kdf { ops: 4194304, mem: 134217728 }
    }
}

#[cfg(test)]
thread_local! {
    /// What the test on this thread makes new accounts of a core without a server at (`None`: `Kdf::local()`), for
    /// the tests of accounts that were made at another cost.
    static TEST_LOCAL_KDF: ::std::cell::RefCell<Option<Kdf>> = ::std::cell::RefCell::new(None);
}

/// What an account of a core without a server is made at.
pub(crate) fn local_kdf() -> Kdf {
    #[cfg(test)]
    {
        if let Some(kdf) = TEST_LOCAL_KDF.with(|kdf| kdf.borrow().clone()) {
            return kdf;
        }
    }
    Kdf::local()
}

/// While this lives, the accounts a core without a server makes on this thread are made at the cost an
/// account of a Turtl server has (an account kept before the cost was kept with it looks like one).
#[cfg(test)]
pub(crate) struct ServerCostAccounts;

#[cfg(test)]
impl ServerCostAccounts {
    pub(crate) fn new() -> ServerCostAccounts {
        TEST_LOCAL_KDF.with(|kdf| *kdf.borrow_mut() = Some(Kdf::default()));
        ServerCostAccounts
    }
}

#[cfg(test)]
impl Drop for ServerCostAccounts {
    fn drop(&mut self) {
        TEST_LOCAL_KDF.with(|kdf| *kdf.borrow_mut() = None);
    }
}

/// What a core without a server keeps of an account (in the key-value store, under
/// `local-account:<username>`): what the server would keep, which is the auth to check a passphrase
/// against and the user's data (its private part is encrypted with the key the passphrase makes), and
/// the cost the passphrase was made into a key at.
#[derive(Serialize, Deserialize)]
pub(crate) struct LocalAccount {
    pub(crate) id: String,
    pub(crate) auth: String,
    #[serde(default)]
    pub(crate) kdf: Kdf,
    pub(crate) data: Value,
    /// A change of passphrase that was started and not finished (see `PendingChange`). Not there when there
    /// is none, so an account's record is what it always was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending: Option<PendingChange>,
}

/// What a change of passphrase leaves in the account's record for as long as it takes (see
/// `User::change_local_passphrase`): what the new passphrase makes (the auth to check it against, the cost it
/// is made at, the user data sealed with its key) and each of the two keys, the one the old passphrase makes and
/// the one the new passphrase makes, sealed with the other. The keys of the notebooks are sealed with the
/// user's key, and they are re-sealed in the user's database, which is a file of its own: no write can reach
/// both at once. So whichever passphrase is typed next can open the vault, and put right whatever a crash
/// left half done (`User::settle_local_change`). Anybody who knows either passphrase has both keys while this
/// is there, which is no more than knowing the old one gave before.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct PendingChange {
    auth: String,
    pub(crate) kdf: Kdf,
    data: Value,
    /// The new key, sealed with the old one (base64).
    new_under_old: String,
    /// The old key, sealed with the new one (base64).
    old_under_new: String,
}

pub(crate) fn local_account_key(username: &str) -> String {
    format!("local-account:{}", username)
}

/// A user id for an account made on this device. Users have numbers for ids (the server hands them out, and
/// what a user owns carries it as a JSON number: see `util::ser::int_converter`), so this is a random
/// positive number, of 52 bits so that a JavaScript host reads it back exactly.
fn random_local_user_id() -> TResult<String> {
    let hash = crypto::random_hash()?;
    match u64::from_str_radix(&hash[..13], 16) {
        Ok(id) => Ok(id.max(1).to_string()),
        Err(e) => TErr!(TError::Msg(format!("user::random_local_user_id() -- {}", e))),
    }
}

/// The record of the account `username` of a core without a server, if there is one.
fn read_local_account(turtl: &Turtl, username: &str) -> TResult<Option<LocalAccount>> {
    let kv_guard = lockr!(turtl.kv);
    match kv_guard.kv_get(&local_account_key(username))? {
        Some(stored) => Ok(Some(jedi::parse(&stored)?)),
        None => Ok(None),
    }
}

/// Change the record of an account and keep it. (The key-value store is locked from reading to writing,
/// so that nothing comes between.)
fn update_local_account<F>(turtl: &Turtl, username: &str, change: F) -> TResult<()>
    where F: FnOnce(&mut LocalAccount) -> TResult<()>
{
    let kv_key = local_account_key(username);
    let kv_guard = lockw!(turtl.kv);
    let mut record: LocalAccount = match kv_guard.kv_get(&kv_key)? {
        Some(stored) => jedi::parse(&stored)?,
        None => return TErr!(TError::NotFound(String::from("the account of this vault is not on this device"))),
    };
    change(&mut record)?;
    kv_guard.kv_set(&kv_key, &jedi::stringify(&record)?)
}

/// A change of passphrase that is worked out and not yet written (see `User::change_local_passphrase`).
pub(crate) struct LocalChange {
    username: String,
    pub(crate) old_key: Key,
    pub(crate) new_key: Key,
    new_auth: String,
    pending: PendingChange,
}

/// What a pass over the keys that the user's key seals found.
#[derive(Debug, Default, PartialEq)]
pub struct Rekeyed {
    /// Keys that were sealed with the other key and are sealed with the new one now.
    pub moved: usize,
    /// Keys that were sealed with the new one already.
    pub kept: usize,
    /// Keys that neither key opens: they are left as they are.
    pub unreadable: usize,
}

/// The rows of one table of the user's database, sealed with `to` or else with `from`, that are not sealed with
/// `to`: opened, and sealed again with it (not saved).
fn resealed_rows<T>(db: &Storage, from: Option<&Key>, to: &Key, found: &mut Rekeyed) -> TResult<Vec<T>>
    where T: Protected + Storable
{
    // a copy of the row, opened with `key` if that is the key that seals it
    fn opened<T: Protected>(row: &T, key: &Key) -> Option<T> {
        let mut copy = row.clone().ok()?;
        copy.set_key(Some(key.clone()));
        Protected::deserialize(&mut copy).ok().map(|_| copy)
    }
    let mut again = Vec::new();
    for row in db.all::<T>(T::tablename())? {
        if opened(&row, to).is_some() {
            found.kept += 1;
        } else if let Some(mut was) = from.and_then(|key| opened(&row, key)) {
            was.set_key(Some(to.clone()));
            Protected::serialize(&mut was)?;
            again.push(was);
            found.moved += 1;
        } else {
            found.unreadable += 1;
        }
    }
    Ok(again)
}

/// Seal every row of the user's database that the user's key seals (the keychain's entries, which hold the keys
/// of the notebooks, and the user's own row if it has one) with `to`. A row is read with `to` or else with
/// `from`, since a change that was stopped leaves some under one and some under the other; one that neither
/// opens is left as it is. What is to be written is written in one transaction: all of it or none.
fn rekey_rows(turtl: &Turtl, from: Option<&Key>, to: &Key) -> TResult<Rekeyed> {
    let mut found = Rekeyed::default();
    turtl.with_user_db(|db| {
        let keys: Vec<KeychainEntry> = resealed_rows(db, from, to, &mut found)?;
        let users: Vec<User> = resealed_rows(db, from, to, &mut found)?;
        if keys.is_empty() && users.is_empty() {
            return Ok(());
        }
        db.begin()?;
        let written = (|| -> TResult<()> {
            for row in &keys { db.save(row)?; }
            for row in &users { db.save(row)?; }
            Ok(())
        })();
        match written {
            Ok(()) => db.commit().map_err(|e| { let _ = db.rollback(); e }),
            Err(e) => {
                let _ = db.rollback();
                Err(e)
            }
        }
    })?;
    Ok(found)
}

#[derive(Serialize, Deserialize, Default)]
struct LoginToken {
    id: String,
    key: Key,
    auth: String,
    username: String,
}

impl LoginToken {
    fn new(id: String, key: Key, auth: String, username: String) -> LoginToken {
        LoginToken {
            id: id,
            key: key,
            auth: auth,
            username: username,
        }
    }
}

make_storable!(User, "users");
impl SyncModel for User {
    // handle change-password syncs
    fn skip_incoming_sync(&self, sync_item: &SyncRecord) -> TResult<bool> {
        Ok(sync_item.action == SyncAction::ChangePassword)
    }
}

impl Keyfinder for User {}

impl Validate for User {
    fn validate(&self) -> Vec<(String, String)> {
        let mut errors = Vec::new();
        if self.username.len() < 3 {
            errors.push(validate::entry("username", t!("Please enter a username 3 characters or longer.")));
        }
        errors
    }
}

impl MemorySaver for User {
    fn mem_update(self, _turtl: &Turtl, sync_item: &mut SyncRecord) -> TResult<()> {
        let action = sync_item.action.clone();
        match action {
            SyncAction::Add | SyncAction::Edit => {
                // NOTE: it's not wise to do a direct edit here (as in, lock
                // Turtl.user) because there are many cases when Turtl.user is
                // already locked when we get here. so instead, we blast out an
                // app event that tells us to edit the user object with the data
                // we have.
                messaging::app_event("user:edit", &self.data()?)?;
            }
            SyncAction::Delete => {
                match messaging::ui_event("user:delete", &()) {
                    Ok(_) => (),
                    Err(e) => error!("User.mem_update() -- problem sending `user:delete` event: {}", e),
                }
                // wiping the user's data has to wait for the sync system to wind down, which this
                // (synchronous, possibly lock-holding) function can't do. so, like the other cases
                // here, we leave it to the dispatcher.
                messaging::app_event("user:wipe-data", &json!({}))?;
            }
            SyncAction::ChangePassword => {
                messaging::app_event("user:change-password:logout", &json!({}))?;
            }
            _ => {}
        }
        Ok(())
    }
}

/// Generate a user's key given some variables or something. `ops` and `mem` are what trying a passphrase
/// costs (scrypt's limits, see `Kdf`).
fn generate_key(username: &String, password: &String, version: u16, ops: usize, mem: usize) -> TResult<Key> {
    let key: Key = match version {
        0 => {
            let hashme = format!("v{}/{}", version, username);
            let salt = crypto::sha512(hashme.as_bytes())?;
            crypto::gen_key(password.as_bytes(), &salt[0..crypto::KEYGEN_SALT_LEN], ops, mem)?
        },
        _ => return TErr!(TError::NotImplemented),
    };
    Ok(key)
}

/// Generate a user's auth token given some variables or something
pub fn generate_auth(username: &String, password: &String, version: u16) -> TResult<(Key, String)> {
    generate_auth_with(username, password, version, &Kdf::default())
}

/// `generate_auth()` with a cost of our choosing: the key and auth an account has are made from its name,
/// its passphrase, and what trying a passphrase costs.
fn generate_auth_with(username: &String, password: &String, version: u16, kdf: &Kdf) -> TResult<(Key, String)> {
    info!("user::generate_auth() -- generating v{} auth", version);
    let key_auth = match version {
        0 => {
            let key = generate_key(username, password, version, kdf.ops, kdf.mem)?;
            let nonce_len = crypto::noncelen();
            let nonce = (crypto::sha512(username.as_bytes())?)[0..nonce_len].to_vec();
            let pw_hash = crypto::to_hex(&crypto::sha512(&password.as_bytes())?)?;
            let user_record = String::from(&pw_hash[..]);
            let op = crypto::CryptoOp::new_with_nonce("chacha20poly1305", nonce)?;
            let auth_bin = crypto::encrypt(&key, Vec::from(user_record.as_bytes()), op)?;
            let auth = crypto::to_hex(&auth_bin)?;
            (key, auth)
        }
        _ => return TErr!(TError::NotImplemented),
    };
    Ok(key_auth)
}

/// Authenticate with the given key/auth: ask the API who we are, then load our user record.
async fn do_login(turtl: &Turtl, username: &String, key: Key, auth: String) -> TResult<()> {
    turtl.api.set_auth(username.clone(), auth.clone())?;
    let opt = ApiReq::new().timeout(10);
    let user_id: Value = turtl.api.post("/auth")?.call_opt(opt).await?;

    let id_err = TErr!(TError::BadValue(format!("auth was successful, but API returned strange id object: {:?}", user_id)));
    let user_id = match user_id {
        Value::Number(x) => {
            match x.as_i64() {
                Some(id) => id.to_string(),
                None => return id_err,
            }
        },
        Value::String(x) => x,
        _ => return id_err,
    };
    let url = format!("/users/{}", user_id);
    {
        let mut user_guard_w = lockw!(turtl.user);
        user_guard_w.id = Some(user_id);
        user_guard_w.do_login(key, auth);
    }
    let userdata: Value = turtl.api.get(url.as_str())?.call().await?;
    let mut user_guard = lockw!(turtl.user);
    user_guard.merge_fields(&userdata)?;
    user_guard.deserialize()?;
    debug!("user::do_login() -- auth success, logged in");
    Ok(())
}

fn validate_user(username: &String, password: &String) -> TResult<()> {
    let mut fake_user_sad = User::default();
    fake_user_sad.username = username.clone();
    fake_user_sad.do_validate(fake_user_sad.model_type())?;
    // these are not in validation because password is not a model field
    let mut errors = Vec::new();
    if password.len() == 0 {
        errors.push(validate::entry("password", t!("Please enter a passphrase. Hint: Sentences are much better than single words.")));
    } else if password.len() < 4 {
        errors.push(validate::entry("password", t!("We don't mean to tell you your business, but a passphrase less than four characters won't cut it. Try again.")));
    } else if password == "password" {
        errors.push(validate::entry("password", t!("That passphrase is making me cringe.")));
    }

    if errors.len() > 0 {
        return TErr!(TError::Validation(fake_user_sad.model_type(), errors));
    }
    Ok(())
}

impl User {
    /// Given a turtl, a username, and a password, see if we can log this user
    /// in. Tries authenticating against various versions, starting from the
    /// given one and working down to the earliest until we get a match or run
    /// out of versions.
    pub async fn login(turtl: &Turtl, username: String, password: String, version: u16) -> TResult<()> {
        let username = username.to_lowercase();
        if turtl.local_only {
            return User::login_local(turtl, username, password);
        }
        let mut version = version;
        loop {
            let (key, auth) = generate_auth(&username, &password, version)?;
            let err = match do_login(turtl, &username, key, auth).await {
                Ok(_) => return Ok(()),
                Err(e) => e,
            };
            turtl.api.clear_auth();
            match err.shed() {
                // if we got a BAD LOGIN error, try again with a different
                // (lesser) auth version
                TError::Api(StatusCode::UNAUTHORIZED, _) if version > 0 => {
                    version -= 1;
                },
                TError::Api(status, msg) => return TErr!(TError::Api(status, msg)),
                e => return Err(e),
            }
        }
    }

    /// Log the user in given a token returned from get_login_token()
    pub async fn login_token(turtl: &Turtl, token: String) -> TResult<()> {
        let token_encrypted = crypto::from_base64(&token)?;
        let token_raw = crypto::decrypt(&(*TOKEN_KEY), token_encrypted)?;
        let tokenjson = String::from_utf8(token_raw)?;
        let token: LoginToken = jedi::parse(&tokenjson)?;
        let LoginToken {id: _id, key, auth, username} = token;
        let username = username.to_lowercase();
        do_login(turtl, &username, key, auth).await?;
        Ok(())
    }

    /// Make an account on this device alone: what the server would be given (the auth and the encrypted user
    /// data) is kept in the key-value store, and the user is logged in. The key is made from the username
    /// and passphrase exactly as for an account on a server (the username is part of the salt, so a core
    /// that stands alone should be given a name of its own that nobody else has).
    fn join_local(turtl: &Turtl, username: String, key: Key, auth: String, kdf: Kdf, userdata: Value) -> TResult<()> {
        let kv_key = local_account_key(&username);
        // (the kv lock is held from the check to the write, so two joins of one name can't both succeed)
        let kv_guard = lockw!(turtl.kv);
        if kv_guard.kv_get(&kv_key)?.is_some() {
            return TErr!(TError::Api(StatusCode::CONFLICT, json!({"error": "that account already exists on this device"})));
        }
        let id = random_local_user_id()?;
        let record = LocalAccount { id: id.clone(), auth: auth.clone(), kdf, data: userdata.clone(), pending: None };

        let mut user_guard_w = lockw!(turtl.user);
        user_guard_w.merge_fields(&userdata)?;
        user_guard_w.id = Some(id);
        user_guard_w.do_login(key, auth);
        if let Err(e) = user_guard_w.deserialize().and_then(|_| kv_guard.kv_set(&kv_key, &jedi::stringify(&record)?)) {
            // an account that could not be kept is not an account: nobody is logged in
            user_guard_w.do_logout();
            return Err(e);
        }
        drop(user_guard_w);
        debug!("user::join_local() -- joined and logged in, on this device only");
        Ok(())
    }

    /// Log in to an account made with `join_local`: the passphrase has to make the key and auth that were
    /// made when the account was. (There is nothing to ask but the account's record, so a wrong passphrase
    /// and a missing account are the same answer.)
    fn login_local(turtl: &Turtl, username: String, password: String) -> TResult<()> {
        let bad_login = || TErr!(TError::Api(StatusCode::UNAUTHORIZED, json!({"error": "bad login"})));
        let record: LocalAccount = {
            let kv_guard = lockr!(turtl.kv);
            match kv_guard.kv_get(&local_account_key(&username))? {
                Some(stored) => jedi::parse(&stored)?,
                None => return bad_login(),
            }
        };
        // (the cost is read from storage, so it is held to what a device can do: a record that asks for
        // more memory than there is would take the whole page down, and one that asks for more work than
        // anyone would wait for would never finish. What a vault is made at (`Kdf::local()`) is far inside this.)
        let too_dear = |kdf: &Kdf| -> TResult<()> {
            if kdf.mem > MAX_KDF_MEM || kdf.ops > MAX_KDF_OPS {
                return TErr!(TError::BadValue(format!("user::login_local() -- the account asks for more to log in than this device allows (ops {}, memory {})", kdf.ops, kdf.mem)));
            }
            Ok(())
        };
        too_dear(&record.kdf)?;
        if let Some(pending) = &record.pending {
            too_dear(&pending.kdf)?;
        }
        let (key, auth) = generate_auth_with(&username, &password, CURRENT_AUTH_VERSION, &record.kdf)?;
        // (while a change of passphrase is not finished both passphrases open the vault: see `PendingChange`)
        let (key, auth, data) = if auth == record.auth {
            (key, auth, &record.data)
        } else if let Some(pending) = &record.pending {
            // (the same cost makes the same key: it is not made twice)
            let (key, auth) = if pending.kdf == record.kdf { (key, auth) } else { generate_auth_with(&username, &password, CURRENT_AUTH_VERSION, &pending.kdf)? };
            if auth != pending.auth {
                return bad_login();
            }
            (key, auth, &pending.data)
        } else {
            return bad_login();
        };
        let mut user_guard_w = lockw!(turtl.user);
        user_guard_w.merge_fields(data)?;
        user_guard_w.id = Some(record.id.clone());
        user_guard_w.do_login(key, auth);
        if let Err(e) = user_guard_w.deserialize() {
            // a user record that the key doesn't open is no login
            user_guard_w.do_logout();
            return Err(e);
        }
        drop(user_guard_w);
        debug!("user::login_local() -- logged in, on this device only");
        Ok(())
    }

    /// The names of the accounts made on this device with `join_local`.
    pub fn local_accounts(turtl: &Turtl) -> TResult<Vec<String>> {
        let kv_guard = lockr!(turtl.kv);
        kv_guard.kv_keys_with_prefix("local-account:")
            .map(|keys| keys.into_iter().map(|k| k["local-account:".len()..].to_string()).collect())
    }

    /// Change the passphrase of the account a core without a server is logged into.
    ///
    /// What the passphrase makes is the user's key, and the keys of the notebooks are sealed with it (the
    /// keychain's entries in the user's database), as is the private part of the user's own record (in the
    /// account's record in the key-value store). Those are what is made new: a new key from the new passphrase,
    /// and everything that was sealed with the old one sealed with it. The notebooks' own keys, and so
    /// the notes and the files, are not touched, which is why this takes as long as it takes to try a passphrase
    /// (twice) and no longer, however much there is. (What it can't do follows from that: whoever has a copy
    /// of the files from before the change, and knows the old passphrase, has the notebooks' keys, and
    /// the keys don't change.)
    ///
    /// The two places can't be written at once, so it goes in steps that a crash can stop between, and
    /// whichever passphrase is typed next finishes it or undoes it (see `PendingChange`, `settle_local_change`):
    ///   1. work out the new key, the new auth and user record, and the keys sealed with each other; nothing is written
    ///   2. write them in the account's record, next to what is there (`pending`): either passphrase opens it now
    ///   3. seal the keys of the database with the new key, in one transaction: all of them or none
    ///   4. the new auth and user record become the account's, and `pending` goes
    /// The core is not asked anything while this runs, so no other command comes between the steps.
    pub fn change_local_passphrase(turtl: &Turtl, current: String, new: String) -> TResult<Rekeyed> {
        let change = User::prepare_local_change(turtl, &current, &new)?;
        User::begin_local_change(turtl, &change)?;
        let found = match User::rekey_local_keys(turtl, &change) {
            Ok(found) => found,
            Err(e) => {
                // the transaction was undone: the keys are as they were, and so the change is dropped
                if let Err(e2) = update_local_account(turtl, &change.username, |record| { record.pending = None; Ok(()) }) {
                    error!("user::change_local_passphrase() -- could not drop the change that did not happen: {}", e2);
                }
                return Err(e);
            }
        };
        User::finish_local_change(turtl, change)?;
        Ok(found)
    }

    /// Step 1 of `change_local_passphrase`: check what is asked and work out what is to be written.
    pub(crate) fn prepare_local_change(turtl: &Turtl, current: &String, new: &String) -> TResult<LocalChange> {
        if !turtl.local_only {
            return TErr!(TError::PermissionDenied(String::from("only a core without a server changes its passphrase this way: the other has `user:change-password`")));
        }
        turtl.user_id()?;
        let (username, old_key, old_auth, user) = {
            let user_guard = lockr!(turtl.user);
            (user_guard.username.clone(), user_guard.key_or_else()?, user_guard.auth.clone(), user_guard.clone()?)
        };
        // the same rules as for the passphrase of a new account, and a passphrase that is another one
        validate_user(&username, new)?;
        if new == current {
            return TErr!(TError::BadValue(String::from("the new passphrase is the one it is now")));
        }
        let record = match read_local_account(turtl, &username)? {
            Some(record) => record,
            None => return TErr!(TError::NotFound(String::from("the account of this vault is not on this device"))),
        };
        if record.pending.is_some() {
            // (the vault has to be locked and unlocked to settle it: a second change on top would seal the
            // keys of the first with the keys of the second, and the first passphrase could not open it)
            return TErr!(TError::BadValue(String::from("an earlier change of passphrase is not finished: lock the vault and unlock it again first")));
        }
        if turtl.with_user_db(|db| Ok(db.in_batch()))? {
            return TErr!(TError::BadValue(String::from("a batch of changes is open: it has to be kept or undone first")));
        }
        // whoever asks has to know the passphrase that unlocked the vault, not just be at an unlocked one
        let (_, auth) = generate_auth_with(&username, current, CURRENT_AUTH_VERSION, &record.kdf)?;
        if old_auth.as_ref() != Some(&auth) {
            return TErr!(TError::Api(StatusCode::UNAUTHORIZED, json!({"error": "bad login"})));
        }

        // (the cost of a passphrase is what a vault is made at: an account that was made at another cost is moved to it)
        let kdf = local_kdf();
        let (new_key, new_auth) = generate_auth_with(&username, new, CURRENT_AUTH_VERSION, &kdf)?;
        let data = {
            let mut next = user;
            // (the account's data has never held its id: the record has it)
            next.id = None;
            next.set_key(Some(new_key.clone()));
            Protected::serialize(&mut next)?
        };
        let pending = PendingChange {
            auth: new_auth.clone(),
            kdf: kdf,
            data: data,
            new_under_old: protected::encrypt_key(&old_key, new_key.clone())?,
            old_under_new: protected::encrypt_key(&new_key, old_key.clone())?,
        };
        Ok(LocalChange { username: username, old_key: old_key, new_key: new_key, new_auth: new_auth, pending: pending })
    }

    /// Step 2: write the change next to what the account is. From here either passphrase opens the vault.
    pub(crate) fn begin_local_change(turtl: &Turtl, change: &LocalChange) -> TResult<()> {
        update_local_account(turtl, &change.username, |record| {
            record.pending = Some(change.pending.clone());
            Ok(())
        })
    }

    /// Step 3: seal the keys in the user's database with the new key.
    pub(crate) fn rekey_local_keys(turtl: &Turtl, change: &LocalChange) -> TResult<Rekeyed> {
        rekey_rows(turtl, Some(&change.old_key), &change.new_key)
    }

    /// Step 4: the new passphrase is the account's, and the user in memory has its key from now on.
    pub(crate) fn finish_local_change(turtl: &Turtl, change: LocalChange) -> TResult<()> {
        // (the keys in the database are under the new key whatever happens to the record, so this session
        // goes on with the new key: it saves a notebook's key under the key that opens the others)
        {
            let mut user_guard = lockw!(turtl.user);
            user_guard.do_login(change.new_key.clone(), change.new_auth.clone());
        }
        update_local_account(turtl, &change.username, |record| {
            match record.pending.take() {
                Some(pending) => {
                    record.auth = pending.auth;
                    record.kdf = pending.kdf;
                    record.data = pending.data;
                    Ok(())
                }
                None => TErr!(TError::MissingField(String::from("the change of passphrase that was being made"))),
            }
        }).map_err(|e| toterr!(TError::Msg(format!("the keys were sealed with the new passphrase but the account could not be given it ({}): unlock the vault again, with the passphrase that is to be kept", e))))
    }

    /// Called when a user has been logged into a core without a server and the user's database is open,
    /// before the profile is read: if a change of passphrase was left unfinished (the page was closed, the
    /// device lost power, the disk was full), the passphrase that was just typed settles it. The new one finishes
    /// it and the old one undoes it, so the passphrase that opened the vault is the one that is the vault's,
    /// and the keys in the database are the ones it makes. Done in any state a change can be left in (nothing
    /// sealed with the new key yet, all of it, or, should it ever happen, some), and again if it is stopped
    /// in the middle of this.
    ///
    /// Says whether it settled one, and which way: `Some(true)` when it finished one, `Some(false)` when it undid one.
    pub(crate) fn settle_local_change(turtl: &Turtl) -> TResult<Option<bool>> {
        let (username, key, auth) = {
            let user_guard = lockr!(turtl.user);
            (user_guard.username.clone(), user_guard.key_or_else()?, user_guard.auth.clone())
        };
        let record = match read_local_account(turtl, &username)? {
            Some(record) => record,
            None => return Ok(None),
        };
        let pending = match &record.pending {
            Some(pending) => pending.clone(),
            None => return Ok(None),
        };
        let typed_old = auth.as_ref() == Some(&record.auth);
        let typed_new = !typed_old && auth.as_ref() == Some(&pending.auth);
        if !typed_old && !typed_new {
            return TErr!(TError::BadValue(String::from("user::settle_local_change() -- the passphrase that was typed is neither of the two the account has")));
        }
        // the other passphrase's key, which the one typed opens
        let other = protected::decrypt_key(&key, if typed_old { &pending.new_under_old } else { &pending.old_under_new });
        let other = match other {
            Ok(other) => Some(other),
            Err(e) => {
                warn!("user::settle_local_change() -- the other key of an unfinished change of passphrase can't be had: {}", e);
                None
            }
        };
        let found = rekey_rows(turtl, other.as_ref(), &key)?;
        if other.is_none() && found.unreadable > 0 {
            // some of the keys are not under this key, and the one they may be under can't be had: nothing is
            // written, so the other passphrase can still be tried
            return TErr!(TError::BadValue(String::from("this vault was left in the middle of a change of passphrase and it can't be put right with this passphrase: try the other one")));
        }
        info!("user::settle_local_change() -- an unfinished change of passphrase was {} ({} keys put under the passphrase that opened the vault, {} already were, {} can't be opened)",
              if typed_new { "finished" } else { "undone" }, found.moved, found.kept, found.unreadable);
        update_local_account(turtl, &username, |record| {
            if let Some(pending) = record.pending.take() {
                if typed_new {
                    record.auth = pending.auth;
                    record.kdf = pending.kdf;
                    record.data = pending.data;
                }
            }
            Ok(())
        })?;
        // (the host tells the person: the passphrase they typed is not necessarily the one they thought they were typing)
        messaging::ui_event("user:passphrase:settled", &json!({"finished": typed_new, "account": username}))?;
        Ok(Some(typed_new))
    }

    pub async fn join(turtl: &Turtl, username: String, password: String) -> TResult<()> {
        validate_user(&username, &password)?;
        let username = username.to_lowercase();
        let kdf = if turtl.local_only { local_kdf() } else { Kdf::default() };
        let (key, auth) = generate_auth_with(&username, &password, CURRENT_AUTH_VERSION, &kdf)?;
        let (pk, sk) = crypto::asym::keygen()?;
        let userdata = {
            let mut user = User::default();
            user.set_key(Some(key.clone()));
            user.username = username.clone();
            user.pubkey = Some(pk);
            user.privkey = Some(sk);
            Protected::serialize(&mut user)?
        };

        if turtl.local_only {
            return User::join_local(turtl, username, key, auth, kdf, userdata);
        }
        turtl.api.set_auth(username.clone(), auth.clone())?;
        let joindata: Value = turtl.api.post("/users")?
            .json(&json!({
                "auth": auth.clone(),
                "username": username,
                "data": userdata,
            }))
            .call().await?;
        let user_id: String = jedi::get(&["id"], &joindata)?;
        let user_id: String = user_id.to_string();
        let mut user_guard_w = lockw!(turtl.user);
        user_guard_w.merge_fields(jedi::walk(&["data"], &joindata)?)?;
        user_guard_w.id = Some(user_id);
        user_guard_w.do_login(key, auth);
        user_guard_w.deserialize()?;
        drop(user_guard_w);

        debug!("user::join() -- auth success, joined and logged in");
        Ok(())
    }

    /// Change the current user's password.
    ///
    /// We do this by creating a new user object, generating a key/auth for it,
    /// using that user's new key to re-encrypt the entire in-memory keychain,
    /// then senting the new username, new auth, and new keychain over the to
    /// API in one bulk post.
    ///
    /// The idea is that this is all or nothing. In previous versions of Turtl
    /// we tried to shoehorn this through the sync system, but this tends to be
    /// a delicate procedure and you really want everything to work or nothing.
    ///
    /// The user and profile are only locked for the parts that read or write
    /// them, never while a request is out.
    pub async fn change_password(turtl: &Turtl, current_username: String, current_password: String, new_username: String, new_password: String) -> TResult<()> {
        validate_user(&new_username, &new_password)?;
        let new_username = new_username.to_lowercase();
        let (_, auth) = generate_auth(&current_username, &current_password, CURRENT_AUTH_VERSION)?;
        let (user_id, mut new_user) = {
            let user_guard = lockr!(turtl.user);
            let user_id = user_guard.id_or_else()?;
            if Some(auth) != user_guard.auth {
                return TErr!(TError::BadValue(String::from("invalid current username/password given")));
            }
            (user_id, user_guard.clone()?)
        };

        new_user.username = new_username;
        let (new_key, new_auth) = generate_auth(&new_user.username, &new_password, CURRENT_AUTH_VERSION)?;
        new_user.set_key(Some(new_key.clone()));
        let new_userdata = Protected::serialize(&mut new_user)?;

        let encrypted_keychain = {
            let profile_guard = lockr!(turtl.profile);
            let mut new_keys = Vec::with_capacity(profile_guard.keychain.entries.len());
            for entry in &profile_guard.keychain.entries {
                let mut new_entry = entry.clone()?;
                new_entry.set_key(Some(new_key.clone()));
                let entrydata = Protected::serialize(&mut new_entry)?;
                new_keys.push(entrydata);
            }
            new_keys
        };

        #[derive(Deserialize, Debug)]
        struct PWChangeResponse {
            #[serde(default)]
            #[serde(deserialize_with = "crate::util::ser::opt_vec_str_i64_converter::deserialize")]
            sync_ids: Option<Vec<i64>>,
        }
        let auth_change = json!({
            "user": new_userdata,
            "auth": new_auth,
            "keychain": encrypted_keychain,
        });
        let url = format!("/users/{}", user_id);
        let res: PWChangeResponse = turtl.api.put(&url[..])?.json(&auth_change).call().await?;
        match res.sync_ids.as_ref() {
            Some(ids) => {
                let mut db_guard = lock!(turtl.db);
                match db_guard.as_mut() {
                    Some(db) => SyncIncoming::ignore_on_next(db, ids)?,
                    None => return TErr!(TError::MissingField(String::from("Turtl.db"))),
                }
            }
            None => {}
        }

        turtl.api.set_auth(new_user.username.clone(), new_auth.clone())?;
        turtl.api.post("/auth")?.call::<String>().await?;
        {
            let mut user_guard = lockw!(turtl.user);
            user_guard.do_login(new_key.clone(), new_auth);
            sync_model::save_model(SyncAction::Edit, turtl, &mut *user_guard, true)?;
        }

        // save the user's new key into the keychain entries
        {
            let mut profile_guard = lockw!(turtl.profile);
            let mut db_guard = lock!(turtl.db);
            let db = match (*db_guard).as_mut() {
                Some(x) => x,
                None => return TErr!(TError::MissingField(format!("Turtl.db"))),
            };
            let user_id = turtl.user_id()?;
            for entry in &mut profile_guard.keychain.entries {
                entry.set_key(Some(new_key.clone()));
                // NOTE: sync_model::save_model() will call mem_update() on our
                // keychain entry, which is bad because that locks the profile
                // (which, as you can see above, is already locked).
                //
                // we kind of side-step syncing here by just directly calling our
                // heroic outgoing() function which saves the object in the db for
                // us. this is pretty much all we'd need save_model() for anyway, so
                // why give it the satisfaction of deadlocking the app?
                entry.outgoing(SyncAction::Edit, &user_id, db, true)?;
            }
        }
        // give the outgoing sync a moment to send what we just saved
        exec::sleep(3000).await;
        Ok(())
    }

    /// Once the user has joined, we set up a default profile for them.
    pub fn post_join(turtl: &Turtl, migrate_data: Option<MigrateResult>) -> TResult<()> {
        let user_id = {
            let user_guard = lockr!(turtl.user);
            user_guard.id_or_else()?
        };

        fn save_space(turtl: &Turtl, user_id: &String, title: &str, color: &str) -> TResult<String> {
            let mut space: Space = Default::default();
            space.generate_key()?;
            space.user_id = user_id.clone();
            space.title = Some(String::from(title));
            space.color = Some(String::from(color));
            let val = sync_model::save_model(SyncAction::Add, turtl, &mut space, false)?;
            let id: String = jedi::get(&["id"], &val)?;
            Ok(id)
        }
        fn save_board(turtl: &Turtl, user_id: &String, space_id: &String, title: &str) -> TResult<String> {
            let mut board: Board = Default::default();
            board.generate_key()?;
            board.user_id = user_id.clone();
            board.space_id = space_id.clone();
            board.title = Some(String::from(title));
            let val = sync_model::save_model(SyncAction::Add, turtl, &mut board, false)?;
            let id: String = jedi::get(&["id"], &val)?;
            Ok(id)
        }

        let personal_space_id = save_space(turtl, &user_id, t!("Personal"), "#408080")?;
        save_space(turtl, &user_id, t!("Work"), "#439645")?;
        save_space(turtl, &user_id, t!("Home"), "#800000")?;
        save_board(turtl, &user_id, &personal_space_id, t!("Bookmarks"))?;
        save_board(turtl, &user_id, &personal_space_id, t!("Photos"))?;
        save_board(turtl, &user_id, &personal_space_id, t!("Passwords"))?;

        // the user's default space id. might change if we have import data
        let mut default_space_id = personal_space_id.clone();

        if let Some(migration) = migrate_data {
            let MigrateResult { boards, notes } = migration;
            let migrate_space_id = save_space(turtl, &user_id, t!("Imported"), "#b7479b")?;
            // if we're importing data, set the space holding the migration data
            // as the default
            default_space_id = migrate_space_id.clone();

            let mut id_map: HashMap<String, String> = HashMap::new();
            let mut title_map: HashMap<String, String> = HashMap::new();
            // map old_board_id => title
            for boardval in &boards {
                let id: String = jedi::get(&["id"], boardval)?;
                let title: String = jedi::get(&["title"], boardval)?;
                title_map.insert(id, title);
            }

            // take an old id, grab the timestamp out of it, and use it as the
            // timestamp in a newly-generated id. useful for upgrading the old
            // mongodb id format (if needed) and also for creating a totally new
            // id but preserving the create date of the object.
            fn val_to_new_id(val: &Value) -> TResult<String> {
                let old_id: String = jedi::get(&["id"], &val)?;
                model::cid_w_timestamp(model::id_timestamp(&old_id)? as u64)
            }

            for mut boardval in boards {
                let old_board_id: String = jedi::get(&["id"], &boardval)?;
                let new_board_id = val_to_new_id(&boardval)?;
                let mut title: String = jedi::get(&["title"], &boardval)?;
                // if we have a parent id and a title related to that parent
                // board, prepend the parent's title to this board's title
                match jedi::get_opt::<String>(&["parent_id"], &boardval) {
                    Some(parent_board_id) => {
                        match title_map.get(&parent_board_id) {
                            Some(parent_title) => {
                                title = format!("{}/{}", parent_title, title);
                            }
                            None => {}
                        }
                    }
                    None => {}
                }
                jedi::set(&["id"], &mut boardval, &new_board_id)?;
                jedi::set(&["user_id"], &mut boardval, &user_id)?;
                jedi::set(&["space_id"], &mut boardval, &migrate_space_id)?;
                jedi::set(&["title"], &mut boardval, &title)?;
                // inthert.......
                id_map.insert(old_board_id, new_board_id);
                let mut board: Board = jedi::from_val(boardval)?;
                sync_model::save_model(SyncAction::Add, turtl, &mut board, false)?;
            }
            for mut noteval in notes {
                let note_boards: Vec<String> = match jedi::get_opt(&["boards"], &noteval) {
                    Some(boards) => boards,
                    None => {
                        match jedi::get_opt(&["board_id"], &noteval) {
                            Some(board_id) => vec![board_id],
                            None => Vec::new(),
                        }
                    }
                };
                let new_note_id = val_to_new_id(&noteval)?;
                jedi::set(&["id"], &mut noteval, &new_note_id)?;
                jedi::set(&["user_id"], &mut noteval, &user_id)?;
                jedi::set(&["space_id"], &mut noteval, &migrate_space_id)?;
                // set the first board_id we have a new id for into this note's
                // board_id field.
                for board_id in note_boards {
                    match id_map.get(&board_id) {
                        Some(new_board_id) => {
                            jedi::set(&["board_id"], &mut noteval, new_board_id)?;
                            break;
                        }
                        None => {}
                    }
                }
                // NOTE: we use dispatch() instead of save_model() here because
                // the note might have a `note.file.filedata` object and we want
                // to save the imported file.
                let mut sync = SyncRecord::default();
                sync.action = SyncAction::Add;
                sync.ty = SyncType::Note;
                sync.data = Some(noteval);
                sync_model::dispatch(turtl, sync)?;
            }
        }

        let mut user_guard_w = lockw!(turtl.user);
        user_guard_w.set_setting(turtl, "default_space", &default_space_id)?;
        user_guard_w.deserialize()?;
        drop(user_guard_w);

        Ok(())
    }

    /// Static method to log a user out
    pub fn logout(turtl: &Turtl) -> TResult<()> {
        let mut user_guard = lockw!(turtl.user);
        if !user_guard.logged_in {
            return Ok(());
        }
        user_guard.do_logout();
        drop(user_guard);
        turtl.api.clear_auth();
        Ok(())
    }

    /// Delete the current user
    pub async fn delete_account(turtl: &Turtl) -> TResult<()> {
        let id = {
            let user_guard = lockr!(turtl.user);
            user_guard.id_or_else()?
        };
        turtl.api.delete(format!("/users/{}", id).as_str())?.call::<bool>().await?;
        Ok(())
    }

    /// Make sure the user object has a keypair (for accepting invites/messages)
    pub fn ensure_keypair(turtl: &Turtl) -> TResult<()> {
        let mut user_guard = lockw!(turtl.user);
        if user_guard.privkey.is_none() {
            info!("User::ensure_keypair() -- missing privkey, regenerating");
            let mut save_user = user_guard.clone()?;
            let (pk, sk) = crypto::asym::keygen()?;
            // set the keypair into turtl.user as a stopgap until the sync goes
            // through, then make sure the guard is dropped before updating
            user_guard.pubkey = Some(pk.clone());
            user_guard.privkey = Some(sk.clone());
            drop(user_guard);
            save_user.pubkey = Some(pk.clone());
            save_user.privkey = Some(sk.clone());
            sync_model::save_model(SyncAction::Edit, turtl, &mut save_user, false)?;
        }
        Ok(())
    }

    /// Resend a user's confirmation email
    pub async fn resend_confirmation(turtl: &Turtl) -> TResult<()> {
        turtl.api.post("/users/confirmation/resend")?.call::<bool>().await?;
        Ok(())
    }

    /// Returns a string that can be saved and used to log back in later.
    ///
    /// WARNING: this token contains the user's master key!!
    pub fn get_login_token(turtl: &Turtl) -> TResult<String> {
        let user_guard = lockr!(turtl.user);
        let auth = match user_guard.auth.as_ref() {
            Some(auth) => auth.clone(),
            None => return TErr!(TError::MissingField(String::from("turtl.user.auth"))),
        };
        let token = LoginToken::new(turtl.user_id()?, user_guard.key_or_else()?, auth, user_guard.username.clone());
        let tokenstr = jedi::stringify(&token)?;
        // add a little bit more protection. obviously, an attacker can just
        // grab this key from the source, but this might stop some less
        // motivated folks.
        let token_encrypted = crypto::encrypt(&(*TOKEN_KEY), Vec::from(tokenstr.as_bytes()), CryptoOp::new("chacha20poly1305")?)?;
        let token = crypto::to_base64(&token_encrypted)?;
        Ok(token)
    }

    /// Grab the currently logged-in user's login token, encrypt it with a
    /// random key, save the result to <data_folder>/<user_id>.login (on wasm32,
    /// where there are no files, into the kv store under `login:<user_id>`), and
    /// return the key.
    pub fn save_login(turtl: &Turtl) -> TResult<Key> {
        let user_id = turtl.user_id()?;
        let login_token = User::get_login_token(turtl)?;
        let key: Key = Key::random()?;
        let enc = crypto::encrypt(&key, Vec::from(login_token.as_bytes()), CryptoOp::new("chacha20poly1305")?)?;
        User::write_saved_login(turtl, &user_id, &enc)?;
        Ok(key)
    }

    /// Restores a login (saved via User::save_login()) given a user_id/key.
    pub fn restore_login(turtl: &Turtl, user_id: String, key: Key) -> TResult<String> {
        let enc = User::read_saved_login(turtl, &user_id)?;
        let login_token_bytes = crypto::decrypt(&key, enc)?;
        let login_token = String::from_utf8(login_token_bytes)?;
        Ok(login_token)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn write_saved_login(_turtl: &Turtl, user_id: &String, enc: &Vec<u8>) -> TResult<()> {
        let mut filepath = PathBuf::from(util::file_folder(None)?);
        filepath.push(user_id.clone() + ".login");
        let mut fs_file = fs::File::create(&filepath)?;
        fs_file.write_all(enc.as_slice())?;
        info!("User::save_login() -- saved login to {:?}", filepath);
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn read_saved_login(_turtl: &Turtl, user_id: &String) -> TResult<Vec<u8>> {
        let mut filepath = PathBuf::from(util::file_folder(None)?);
        filepath.push(user_id.clone() + ".login");
        let mut file = fs::File::open(&filepath)?;
        let mut enc = Vec::new();
        file.read_to_end(&mut enc)?;
        info!("User::restore_login() -- restored login from {:?}", filepath);
        Ok(enc)
    }

    #[cfg(target_arch = "wasm32")]
    fn write_saved_login(turtl: &Turtl, user_id: &String, enc: &Vec<u8>) -> TResult<()> {
        let kv_guard = lockr!(turtl.kv);
        kv_guard.kv_set(format!("login:{}", user_id).as_str(), &crypto::to_base64(enc)?)?;
        info!("User::save_login() -- saved login to the kv store");
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    fn read_saved_login(turtl: &Turtl, user_id: &String) -> TResult<Vec<u8>> {
        let kv_guard = lockr!(turtl.kv);
        match kv_guard.kv_get(format!("login:{}", user_id).as_str())? {
            Some(enc) => Ok(crypto::from_base64(&enc)?),
            None => TErr!(TError::NotFound(format!("no saved login for user {}", user_id))),
        }
    }

    /// We have a successful key/auth pair. Log the user in.
    pub fn do_login(&mut self, key: Key, auth: String) {
        self.set_key(Some(key));
        self.auth = Some(auth);
        self.logged_in = true;
    }

    /// Logout the user
    pub fn do_logout(&mut self) {
        self.set_key(None);
        self.auth = None;
        self.logged_in = false;
    }

    /// Set a setting into this user's settings object
    pub fn set_setting<T>(&mut self, turtl: &Turtl, key: &str, val: &T) -> TResult<()>
        where T: Serialize
    {
        if self.settings.is_none() {
            self.settings = Some(Default::default());
        }
        match self.settings.as_mut() {
            Some(ref mut settings) => {
                settings.insert(String::from(key), jedi::to_val(val)?);
            },
            None => {
                return TErr!(TError::MissingField(String::from("User.settings")));
            }
        }
        sync_model::save_model(SyncAction::Edit, turtl, self, false)?;
        Ok(())
    }

    /// Given an email address, find a matching user (pubkey and all)
    pub async fn find_by_email(turtl: &Turtl, email: &String) -> TResult<Option<User>> {
        let url = format!("/users/email/{}", email.to_lowercase());
        turtl.api.get(url.as_str())?.call().await
    }
}

#[cfg(test)]
mod tests {
    //! Tests for our high-level Crypto module interface.

    use super::*;

    #[test]
    pub fn authgen() {
        let username = String::from("andrew@lyonbros.com");
        let password = String::from("slippy");
        let (_key, auth) = generate_auth(&username, &password, 0).unwrap();
        assert_eq!(auth, "000601000c9af06607bbb78b0cab4e01f29a8d06da9a65e5698768b88ac4f4c04002c96fcfcb18a1644d5ba2546901452d0ebd6c162fe494997b52660d9d190ed525076523a1a576ea7596fdaec2e0f0606f3290bd6e5815f76889a4eada71fc20dad21703453928c74db36880cf6035922e3f7093ed1eef01a630750ebd8d64baaf34e325536011de40f3a72a4d95155ca32e851257d8bc7736d2d41c92213e93");
    }
}
