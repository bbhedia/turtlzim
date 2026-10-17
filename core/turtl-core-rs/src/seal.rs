//! Sealed copies of a notebook, for a place that must not be able to read it (a server, a folder of a cloud service).
//!
//! A notebook that is kept elsewhere is kept **page by page**, as one object for each page and each attachment and one for the index, and every object is sealed
//! here, with keys that the other place never has. What the other place sees of a notebook is that objects exist, how big they are and when they changed; not what a
//! page says, what it is called, how the pages are laid out, or what the notebook is called (the index, which holds all that, is sealed too).
//!
//! ```text
//! master (32 random bytes)        one for the account; kept in the vault's keychain, and, sealed under the vault's passphrase, wherever the account keeps its copies
//!   notebook key  = HMAC(master, "zim-seal v1 notebook" 0 notebook id)           (nothing is stored for a notebook: its key is made from the master and its id)
//!     names key   = HMAC(notebook key, "zim-seal v1 names")                       an object's name is HMAC(names key, path), in hex: the path does not show
//!     content key = HMAC(notebook key, "zim-seal v1 content")
//!
//! an object   "ZSO1"  nonce (12)  ChaCha20-Poly1305 (content key, nonce, "zim-seal v1 object" 0 name, plaintext)   (the tag, 16 bytes, is at the end)
//! the index   an object named "index.zseal" holding JSON { v, counter, title, files: [{ path, name, size, sha256 }] }
//! the master, wrapped by a passphrase   "ZSW1"  ops (u32)  mem (u32)  salt (32)  nonce (12)  then the master sealed by ChaCha20-Poly1305 under scrypt(passphrase, salt, ops, mem), with the
//!                                       bytes before the nonce (the magic, the cost and the salt) as additional data, so a changed cost fails to open
//! ```
//!
//! An object's name is its additional data, so an object put under another name does not open; the index holds the SHA-256 of each page, so an old version of one that is
//! put back is noticed once the index is newer; and the index's counter lets a device that remembers the highest it has seen notice a whole old copy put back. What this does
//! not defend against: whoever keeps the objects keeps every version that was ever sent, and can try passphrases at the cost of the wrapped master (128 MiB of memory a try); and a copy of
//! the whole notebook that is old but consistent is believable to a device that has never seen a newer one.
//!
//! The cipher is ChaCha20-Poly1305 (IETF, a 96-bit nonce chosen at random for each object): the one the rest of the core uses, on both targets. A key is made to seal fewer
//! than 2^32 objects, which is billions of edits; a notebook's key is the only key that seals its objects.
use ::jedi::{self, Value};
use crate::crypto::{self, CResult, CryptoError, Key};
use ::std::convert::TryFrom;
use crate::error::{TError, TResult};
use crate::models::keychain;
use crate::models::user::{self, Kdf, MAX_KDF_MEM, MAX_KDF_OPS};
use crate::turtl::Turtl;

const OBJECT_MAGIC: &[u8] = b"ZSO1";
const WRAP_MAGIC: &[u8] = b"ZSW1";
const MASTER_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// What the keychain calls the account's master key, and its type there.
pub const MASTER_ID: &str = "zim-cloud-master";
const MASTER_TYPE: &str = "cloud";
/// The object that holds a notebook's index.
pub const INDEX_NAME: &str = "index.zseal";
const INDEX_VERSION: u64 = 1;
/// The most files an index lists, and the most that one command is given or gives (a command is a message).
const MAX_FILES: usize = 20_000;
const MAX_ITEMS: usize = 2_000;
const MAX_BYTES: usize = 64 << 20;

/// The two keys of a notebook, made from the account's master key and the notebook's id.
pub struct NotebookKeys {
    names: Vec<u8>,
    content: Vec<u8>,
}

fn derive(key: &[u8], label: &str, extra: &[u8]) -> CResult<Vec<u8>> {
    let mut data = Vec::with_capacity(16 + label.len() + extra.len());
    data.extend_from_slice(b"zim-seal v1 ");
    data.extend_from_slice(label.as_bytes());
    data.push(0);
    data.extend_from_slice(extra);
    crypto::hmac(key, &data)
}

/// A notebook's id is what the place that keeps its objects calls it: letters, digits, `_` and `-`, 8 to 64 of them.
pub fn valid_notebook_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The keys of a notebook.
pub fn notebook_keys(master: &[u8], notebook: &str) -> CResult<NotebookKeys> {
    if master.len() != MASTER_LEN {
        return Err(CryptoError::BadData(String::from("seal: the master key is not 32 bytes")));
    }
    if !valid_notebook_id(notebook) {
        return Err(CryptoError::BadData(String::from("seal: that is not a notebook id")));
    }
    let nb = derive(master, "notebook", notebook.as_bytes())?;
    Ok(NotebookKeys { names: derive(&nb, "names", b"")?, content: derive(&nb, "content", b"")? })
}

/// What a file of the notebook is called where the objects are kept: 32 hex digits of its keyed hash, so that two notebooks (or two files) share nothing, and the path does not show.
pub fn object_name(keys: &NotebookKeys, path: &str) -> CResult<String> {
    let tag = crypto::hmac(&keys.names, path.as_bytes())?;
    Ok(format!("{}.zseal", &crypto::to_hex(&tag)?[..32]))
}

fn object_aad(name: &str) -> Vec<u8> {
    let mut aad = b"zim-seal v1 object\0".to_vec();
    aad.extend_from_slice(name.as_bytes());
    aad
}

fn seal_with_nonce(keys: &NotebookKeys, name: &str, plaintext: &[u8], nonce: &[u8]) -> CResult<Vec<u8>> {
    let sealed = crypto::aead_encrypt(&keys.content, nonce, &object_aad(name), plaintext)?;
    let mut out = Vec::with_capacity(OBJECT_MAGIC.len() + NONCE_LEN + sealed.len());
    out.extend_from_slice(OBJECT_MAGIC);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Seal an object that is to be kept under `name`.
pub fn seal(keys: &NotebookKeys, name: &str, plaintext: &[u8]) -> CResult<Vec<u8>> {
    seal_with_nonce(keys, name, plaintext, &crypto::random_nonce()?)
}

/// Open an object that was kept under `name`. It does not open under another name, with another key, or if a byte of it was changed.
pub fn open(keys: &NotebookKeys, name: &str, sealed: &[u8]) -> CResult<Vec<u8>> {
    if sealed.len() < OBJECT_MAGIC.len() + NONCE_LEN + TAG_LEN || &sealed[..OBJECT_MAGIC.len()] != OBJECT_MAGIC {
        return Err(CryptoError::BadData(String::from("seal: that is not a sealed object")));
    }
    let nonce = &sealed[OBJECT_MAGIC.len()..OBJECT_MAGIC.len() + NONCE_LEN];
    crypto::aead_decrypt(&keys.content, nonce, &object_aad(name), &sealed[OBJECT_MAGIC.len() + NONCE_LEN..])
        .map_err(|_| CryptoError::Authentication(String::from("seal: wrong key, or the object was changed, or it is not the one kept under that name")))
}

// ------------------------------------------------------------------------------------------------------------------------------------
// the index

/// One file of the notebook, as the index lists it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// What a notebook holds: its name, and where each file is kept.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Index {
    pub v: u64,
    /// Goes up with each version of the index: a device that remembers the highest it has seen can tell an old copy put back.
    pub counter: u64,
    pub title: String,
    pub files: Vec<IndexEntry>,
}

fn valid_name(name: &str) -> bool {
    name.len() == 38 && name.ends_with(".zseal") && name[..32].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 240 && !path.starts_with('/') && !path.chars().any(|c| c.is_control() || c == '\\') && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn check_index(index: &Index) -> CResult<()> {
    let bad = |why: &str| Err(CryptoError::BadData(format!("seal: the index is not valid ({})", why)));
    if index.v != INDEX_VERSION {
        return bad("a version this program does not know");
    }
    if index.files.len() > MAX_FILES || index.title.len() > 400 {
        return bad("too big");
    }
    let mut names = ::std::collections::HashSet::new();
    let mut paths = ::std::collections::HashSet::new();
    for file in &index.files {
        if !valid_path(&file.path) || !valid_name(&file.name) || file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return bad("a file is not listed properly");
        }
        if !names.insert(file.name.clone()) || !paths.insert(file.path.to_lowercase()) {
            return bad("a file is listed twice");
        }
    }
    Ok(())
}

/// Seal the index, as the object called `index.zseal`.
pub fn seal_index(keys: &NotebookKeys, index: &Index) -> CResult<Vec<u8>> {
    check_index(index)?;
    let json = jedi::stringify(index).map_err(|e| CryptoError::Msg(format!("seal: {}", e)))?;
    seal(keys, INDEX_NAME, json.as_bytes())
}

/// Open the index, and check that it says what an index says.
pub fn open_index(keys: &NotebookKeys, sealed: &[u8]) -> CResult<Index> {
    let bytes = open(keys, INDEX_NAME, sealed)?;
    let text = String::from_utf8(bytes).map_err(|_| CryptoError::BadData(String::from("seal: the index is not text")))?;
    let index: Index = jedi::parse(&text).map_err(|_| CryptoError::BadData(String::from("seal: the index can't be read")))?;
    check_index(&index)?;
    Ok(index)
}

// ------------------------------------------------------------------------------------------------------------------------------------
// the master key, wrapped by a passphrase

const WRAP_HEADER: usize = 4 + 4 + 4 + crypto::KEYGEN_SALT_LEN;

fn wrap_master_with(master: &[u8], passphrase: &str, kdf: &Kdf, salt: &[u8], nonce: &[u8]) -> CResult<Vec<u8>> {
    if master.len() != MASTER_LEN {
        return Err(CryptoError::BadData(String::from("seal: the master key is not 32 bytes")));
    }
    let ops = u32::try_from(kdf.ops).map_err(|_| CryptoError::BadData(String::from("seal: that cost is too big")))?;
    let mem = u32::try_from(kdf.mem).map_err(|_| CryptoError::BadData(String::from("seal: that cost is too big")))?;
    let mut header = Vec::with_capacity(WRAP_HEADER);
    header.extend_from_slice(WRAP_MAGIC);
    header.extend_from_slice(&ops.to_be_bytes());
    header.extend_from_slice(&mem.to_be_bytes());
    header.extend_from_slice(salt);
    let key = crypto::gen_key(passphrase.as_bytes(), salt, kdf.ops, kdf.mem)?;
    let sealed = crypto::aead_encrypt(key.data(), nonce, &header, master)?;
    let mut out = header;
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// The master key, sealed so that only the passphrase opens it (and its cost, which the file carries, makes each try dear).
pub fn wrap_master(master: &[u8], passphrase: &str, kdf: &Kdf) -> CResult<Vec<u8>> {
    wrap_master_with(master, passphrase, kdf, &crypto::random_salt()?, &crypto::random_nonce()?)
}

/// The master key out of what `wrap_master` made, with the passphrase it was made with. A cost that no device can bear, or that is lower than a vault's, is refused: the cost is part of
/// what is sealed (a changed byte fails), but a file that asks for a gigabyte and a day is not to be run.
pub fn unwrap_master(wrapped: &[u8], passphrase: &str) -> CResult<Vec<u8>> {
    if wrapped.len() != WRAP_HEADER + NONCE_LEN + MASTER_LEN + TAG_LEN || &wrapped[..4] != WRAP_MAGIC {
        return Err(CryptoError::BadData(String::from("seal: that is not a wrapped key")));
    }
    let ops = u32::from_be_bytes([wrapped[4], wrapped[5], wrapped[6], wrapped[7]]) as usize;
    let mem = u32::from_be_bytes([wrapped[8], wrapped[9], wrapped[10], wrapped[11]]) as usize;
    if ops > MAX_KDF_OPS || mem > MAX_KDF_MEM || ops < crypto::KEYGEN_OPS_DEFAULT || mem < crypto::KEYGEN_MEM_DEFAULT {
        return Err(CryptoError::BadData(String::from("seal: that wrapped key asks for a cost that this device does not accept")));
    }
    let header = &wrapped[..WRAP_HEADER];
    let key = crypto::gen_key(passphrase.as_bytes(), &wrapped[12..WRAP_HEADER], ops, mem)?;
    let nonce = &wrapped[WRAP_HEADER..WRAP_HEADER + NONCE_LEN];
    crypto::aead_decrypt(key.data(), nonce, header, &wrapped[WRAP_HEADER + NONCE_LEN..]).map_err(|_| CryptoError::Authentication(String::from("seal: wrong passphrase, or the wrapped key was changed")))
}

// ------------------------------------------------------------------------------------------------------------------------------------
// the commands (see `dispatch`): the master key stays in the vault's keychain, and no command hands it out unwrapped

fn master_key(turtl: &Turtl) -> TResult<Option<Key>> {
    if !lockr!(turtl.user).logged_in {
        return TErr!(TError::MissingData(String::from("the vault is locked")));
    }
    Ok(lockr!(turtl.profile).keychain.find_key(&String::from(MASTER_ID)))
}

fn need_master(turtl: &Turtl) -> TResult<Key> {
    match master_key(turtl)? {
        Some(key) => Ok(key),
        None => TErr!(TError::NotFound(String::from("this vault has no key for sealed copies yet"))),
    }
}

fn keep_master(turtl: &Turtl, master: &Key) -> TResult<()> {
    keychain::save_key(turtl, &String::from(MASTER_ID), master, &String::from(MASTER_TYPE), true)
}

/// The `at`th element of the command (0 is the message id, 1 the command): text.
fn string_arg(data: &Value, at: usize, what: &str) -> TResult<String> {
    match data.get(at).and_then(|v| v.as_str()) {
        Some(text) => Ok(String::from(text)),
        None => TErr!(TError::BadValue(format!("{} must be text", what))),
    }
}

/// A short value that says which master key it is without saying anything of it (the first 16 bytes of an HMAC of a constant): two places that hold keys can tell whether they hold the
/// same one, without a passphrase. (The key is 256 bits of randomness: this is no way in.)
pub fn key_check(master: &[u8]) -> CResult<String> {
    Ok(crypto::to_hex(&derive(master, "check", b"")?[..16].to_vec())?)
}

/// Whether this vault has a key for sealed copies, and its check value.
pub fn master_status(turtl: &Turtl) -> TResult<Value> {
    Ok(match master_key(turtl)? {
        Some(master) => json!({"has": true, "check": key_check(master.data())?}),
        None => json!({"has": false}),
    })
}

/// Make a master key for the account, and give it back wrapped by the passphrase (to be kept wherever the account keeps its copies). Nothing is kept in the vault: the key is taken
/// into the vault (`seal:master:unwrap`) once the place that keeps the wrapped one has accepted it, so that two devices that make a key at the same moment do not end up with two.
/// The passphrase has to be the vault's: a key wrapped by another would not open with the passphrase that opens everything else.
pub fn master_make(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let passphrase = string_arg(data, 2, "the passphrase")?;
    master_key(turtl)?; // (the vault has to be unlocked)
    user::verify_local_passphrase(turtl, &passphrase)?;
    let master = Key::new(crypto::rand_bytes(MASTER_LEN)?);
    let wrapped = wrap_master(master.data(), &passphrase, &user::local_kdf())?;
    Ok(json!({"wrapped": crypto::to_base64(&wrapped)?, "check": key_check(master.data())?}))
}

/// The master key of this vault again, wrapped by a passphrase (the vault's, which is the new one after it was changed). Whoever asks has to know the vault's passphrase: wrapping hands the key out.
pub fn master_wrap(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let passphrase = string_arg(data, 2, "the passphrase")?;
    let master = need_master(turtl)?;
    user::verify_local_passphrase(turtl, &passphrase)?;
    Ok(json!({"wrapped": crypto::to_base64(&wrap_master(master.data(), &passphrase, &user::local_kdf())?)?, "check": key_check(master.data())?}))
}

/// Forget this vault's key for sealed copies, so that the vault can take another (`seal:master:unwrap`): the keychain's entry is deleted (written over in the files, as everything the core
/// deletes). It takes the vault's own passphrase, as wrapping does: what is sealed with the key and kept where only it opens (a copy on a connected service) can't be opened by this vault
/// afterwards, and the key is not recoverable from here. A vault that has none has nothing to forget.
pub fn master_forget(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let passphrase = string_arg(data, 2, "the passphrase")?;
    let had = master_key(turtl)?.is_some(); // (the vault has to be unlocked)
    user::verify_local_passphrase(turtl, &passphrase)?;
    if had {
        keychain::remove_key(turtl, &String::from(MASTER_ID), true)?;
        // (deleting the entry from the files does not take it out of the keychain that is in memory: it is taken out here, or the key would go on being used until the next unlock)
        lockw!(turtl.profile).keychain.remove_entry(&String::from(MASTER_ID), None)?;
    }
    Ok(json!({"forgot": had}))
}

/// Take the master key out of a wrapped one with its passphrase and keep it in the vault. A vault that has another master key is not given a second.
pub fn master_unwrap(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let wrapped = crypto::from_base64(&string_arg(data, 2, "the wrapped key")?)?;
    let passphrase = string_arg(data, 3, "the passphrase")?;
    let existing = master_key(turtl)?;
    let master = Key::new(unwrap_master(&wrapped, &passphrase)?);
    let check = key_check(master.data())?;
    match existing {
        Some(have) if have.data() != master.data() => TErr!(TError::BadValue(String::from("this vault has a different key for sealed copies already"))),
        Some(_) => Ok(json!({"kept": false, "check": check})),
        None => {
            keep_master(turtl, &master)?;
            Ok(json!({"kept": true, "check": check}))
        }
    }
}

fn keys_for(turtl: &Turtl, data: &Value) -> TResult<NotebookKeys> {
    let notebook = string_arg(data, 2, "the notebook id")?;
    Ok(notebook_keys(need_master(turtl)?.data(), &notebook)?)
}

fn items(data: &Value, at: usize) -> TResult<Vec<Value>> {
    match data.get(at).and_then(|v| v.as_array()) {
        Some(list) if list.len() <= MAX_ITEMS => Ok(list.clone()),
        Some(_) => TErr!(TError::BadValue(format!("at most {} objects at a time", MAX_ITEMS))),
        None => TErr!(TError::BadValue(String::from("a list was expected"))),
    }
}

fn text(item: &Value, field: &str) -> TResult<String> {
    match item.get(field).and_then(|v| v.as_str()) {
        Some(text) => Ok(String::from(text)),
        None => TErr!(TError::BadValue(format!("`{}` was expected", field))),
    }
}

/// Seal files: `[notebook id, [{path, data (base64)}]]` becomes `[{path, name, sealed (base64), size, sha256}]`, ready to be kept under their names.
pub fn seal_objects(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let keys = keys_for(turtl, data)?;
    let mut total = 0usize;
    let mut out = Vec::new();
    for item in items(data, 3)? {
        let path = text(&item, "path")?;
        if !valid_path(&path) {
            return TErr!(TError::BadValue(format!("{:?} is not a path of a notebook", path)));
        }
        let plain = crypto::from_base64(&text(&item, "data")?)?;
        total += plain.len();
        if total > MAX_BYTES {
            return TErr!(TError::BadValue(format!("at most {} bytes at a time", MAX_BYTES)));
        }
        let name = object_name(&keys, &path)?;
        let sealed = seal(&keys, &name, &plain)?;
        out.push(json!({"path": path, "name": name, "sealed": crypto::to_base64(&sealed)?, "size": plain.len(), "sha256": crypto::to_hex(&crypto::sha256(&plain)?)?}));
    }
    Ok(Value::Array(out))
}

/// Open objects: `[notebook id, [{name, sealed (base64)}]]` becomes `[{name, data (base64)}]`. One that does not open is an error for the whole call (nothing is half given).
pub fn open_objects(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let keys = keys_for(turtl, data)?;
    let mut total = 0usize;
    let mut out = Vec::new();
    for item in items(data, 3)? {
        let name = text(&item, "name")?;
        if !valid_name(&name) {
            return TErr!(TError::BadValue(format!("{:?} is not the name of a sealed object", name)));
        }
        let plain = open(&keys, &name, &crypto::from_base64(&text(&item, "sealed")?)?)?;
        total += plain.len();
        if total > MAX_BYTES {
            return TErr!(TError::BadValue(format!("at most {} bytes at a time", MAX_BYTES)));
        }
        out.push(json!({"name": name, "data": crypto::to_base64(&plain)?}));
    }
    Ok(Value::Array(out))
}

/// Seal an index: `[notebook id, {counter, title, files: [{path, name, size, sha256}]}]` becomes the sealed object (base64) that is kept as `index.zseal`.
pub fn seal_index_command(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let keys = keys_for(turtl, data)?;
    let given = match data.get(3) {
        Some(value) => value.clone(),
        None => return TErr!(TError::BadValue(String::from("an index was expected"))),
    };
    let mut index: Index = match jedi::from_val(json!({"v": INDEX_VERSION, "counter": given["counter"], "title": given["title"], "files": given["files"]})) {
        Ok(index) => index,
        Err(_) => return TErr!(TError::BadValue(String::from("that is not an index"))),
    };
    index.v = INDEX_VERSION;
    Ok(json!({"sealed": crypto::to_base64(&seal_index(&keys, &index)?)?}))
}

/// Open an index: `[notebook id, sealed (base64)]` becomes `{counter, title, files}`.
pub fn open_index_command(turtl: &Turtl, data: &Value) -> TResult<Value> {
    let keys = keys_for(turtl, data)?;
    let index = open_index(&keys, &crypto::from_base64(&string_arg(data, 3, "the sealed index")?)?)?;
    Ok(json!({"counter": index.counter, "title": index.title, "files": index.files}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn master() -> Vec<u8> {
        (1u8..=32).collect()
    }
    fn keys() -> NotebookKeys {
        notebook_keys(&master(), "notebook-0001").unwrap()
    }
    fn hex(data: &[u8]) -> String {
        crypto::to_hex(&data.to_vec()).unwrap()
    }
    fn nonce() -> Vec<u8> {
        (100u8..112).collect()
    }
    /// What a person's vault is made at when it is made for a test: the same as the cost the tests of accounts use.
    fn cost() -> Kdf {
        Kdf::default()
    }

    // The known answers below were made by the native build and are checked on wasm32 too (`crypto_test!`): the same bytes on both targets is what lets a copy sealed in a
    // browser be opened by the desktop program, and the other way round.
    fn known_answers_body() {
        let k = keys();
        assert_eq!(hex(&k.names), "11bb10ce9b9a5429699e4586b66ac861a7bed16da02ef5766f181feb8593446a");
        assert_eq!(hex(&k.content), "ba2cfcccb9ba3a479b5e6b9991e21728047f62972ef618651f9f88d95cebce37");
        assert_eq!(key_check(&master()).unwrap(), "3195bbd92ea74f2364421dcde9feeab6");
        assert_ne!(key_check(&master()).unwrap(), key_check(&[9u8; 32]).unwrap(), "two keys have two check values");
        assert_eq!(object_name(&k, "Home.txt").unwrap(), "cff7659136e2e49f1123e6edc5771425.zseal");
        assert_eq!(object_name(&k, "Help/Editor page.txt").unwrap(), "5b50d35ddf905d637922e62c23ddae39.zseal");
        let sealed = seal_with_nonce(&k, "cff7659136e2e49f1123e6edc5771425.zseal", "Hello é\n".as_bytes(), &nonce()).unwrap();
        assert_eq!(hex(&sealed), "5a534f316465666768696a6b6c6d6e6f9c2e98a443a8fd8e74828de380596d745d95fb71bf8d50394e");
        assert_eq!(open(&k, "cff7659136e2e49f1123e6edc5771425.zseal", &sealed).unwrap(), "Hello é\n".as_bytes());
        let other = notebook_keys(&master(), "notebook-0002").unwrap();
        assert_ne!(hex(&other.content), hex(&k.content), "two notebooks do not share a key");
        let salt: Vec<u8> = (200u8..232).collect();
        let wrapped = wrap_master_with(&master(), "a passphrase to keep", &cost(), &salt, &nonce()).unwrap();
        assert_eq!(hex(&wrapped), "5a5357310008000001000000c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e76465666768696a6b6c6d6e6f915c6263b14ea8ff13aa901cfd84ec863157ae8f92e4d9e6916bed17b258403000d52bc6b40a0609018be5d52048f9cf");
        assert_eq!(unwrap_master(&wrapped, "a passphrase to keep").unwrap(), master());
    }
    crypto_test!(known_answers, known_answers_body);

    fn round_trips_body() {
        let k = keys();
        for plain in &[&b""[..], &b"x"[..], &[0u8, 255, 10, 13, 128][..], &vec![7u8; 100_000][..]] {
            let sealed = seal(&k, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zseal", plain).unwrap();
            assert_eq!(sealed.len(), plain.len() + 4 + 12 + 16);
            assert_eq!(&open(&k, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zseal", &sealed).unwrap()[..], *plain);
        }
        // a nonce is chosen each time: the same page sealed twice is not the same bytes
        let a = seal(&k, "n", b"same").unwrap();
        let b = seal(&k, "n", b"same").unwrap();
        assert_ne!(a, b);
        assert_eq!(object_name(&k, "Home.txt").unwrap(), object_name(&k, "Home.txt").unwrap());
        assert_ne!(object_name(&k, "Home.txt").unwrap(), object_name(&k, "home.txt").unwrap(), "names are of the path as written");
    }
    crypto_test!(round_trips, round_trips_body);

    fn refuses_what_is_not_the_object_body() {
        let k = keys();
        let sealed = seal(&k, "one", b"a page that says something").unwrap();
        assert!(open(&k, "two", &sealed).is_err(), "another name");
        assert!(open(&notebook_keys(&master(), "notebook-0002").unwrap(), "one", &sealed).is_err(), "another notebook's key");
        let mut other_master = master();
        other_master[0] ^= 1;
        assert!(open(&notebook_keys(&other_master, "notebook-0001").unwrap(), "one", &sealed).is_err(), "another master key");
        // every byte, one at a time
        for at in 0..sealed.len() {
            let mut changed = sealed.clone();
            changed[at] ^= 0x01;
            assert!(open(&k, "one", &changed).is_err(), "a changed byte {} opened", at);
        }
        // every cut
        for len in 0..sealed.len() {
            assert!(open(&k, "one", &sealed[..len]).is_err(), "a cut at {} opened", len);
        }
        let mut longer = sealed.clone();
        longer.push(0);
        assert!(open(&k, "one", &longer).is_err());
    }
    crypto_test!(refuses_what_is_not_the_object, refuses_what_is_not_the_object_body);

    fn refuses_bad_keys_and_ids_body() {
        assert!(notebook_keys(&[0u8; 31], "notebook-0001").is_err());
        assert!(notebook_keys(&master(), "short").is_err());
        assert!(notebook_keys(&master(), "has a space in it").is_err());
        assert!(notebook_keys(&master(), "../../../etc/passwd").is_err());
        assert!(valid_notebook_id("AbC_-123"));
    }
    crypto_test!(refuses_bad_keys_and_ids, refuses_bad_keys_and_ids_body);

    fn an_index_is_sealed_and_checked_body() {
        let k = keys();
        let name = object_name(&k, "Home.txt").unwrap();
        let entry = IndexEntry { path: String::from("Home.txt"), name: name.clone(), size: 12, sha256: hex(&crypto::sha256(b"x").unwrap()) };
        let index = Index { v: 1, counter: 7, title: String::from("Journal"), files: vec![entry.clone()] };
        let sealed = seal_index(&k, &index).unwrap();
        assert_eq!(open_index(&k, &sealed).unwrap(), index);
        // the index is sealed under the name `index.zseal` and nothing else
        assert!(open(&k, &name, &sealed).is_err());
        assert!(open_index(&notebook_keys(&master(), "notebook-0002").unwrap(), &sealed).is_err());
        // what an index may not say is refused when it is made and when it is opened
        for (why, bad) in vec![
            ("a version it does not know", Index { v: 2, ..index.clone() }),
            ("a path that leaves the notebook", Index { files: vec![IndexEntry { path: String::from("../x.txt"), ..entry.clone() }], ..index.clone() }),
            ("an absolute path", Index { files: vec![IndexEntry { path: String::from("/x.txt"), ..entry.clone() }], ..index.clone() }),
            ("a name that is not an object's", Index { files: vec![IndexEntry { name: String::from("Home.txt"), ..entry.clone() }], ..index.clone() }),
            ("a sum that is not one", Index { files: vec![IndexEntry { sha256: String::from("abc"), ..entry.clone() }], ..index.clone() }),
            ("a name twice", Index { files: vec![entry.clone(), IndexEntry { path: String::from("Other.txt"), ..entry.clone() }], ..index.clone() }),
            ("a path twice, in two spellings", Index { files: vec![entry.clone(), IndexEntry { path: String::from("home.TXT"), name: object_name(&k, "home.TXT").unwrap(), ..entry.clone() }], ..index.clone() }),
        ] {
            assert!(seal_index(&k, &bad).is_err(), "an index with {} was sealed", why);
            // (one that someone sealed with the right key, but should not have)
            let json = jedi::stringify(&bad).unwrap();
            let sealed_bad = seal(&k, INDEX_NAME, json.as_bytes()).unwrap();
            assert!(open_index(&k, &sealed_bad).is_err(), "an index with {} was opened", why);
        }
        let sealed_text = seal(&k, INDEX_NAME, b"not json at all").unwrap();
        assert!(open_index(&k, &sealed_text).is_err());
    }
    crypto_test!(an_index_is_sealed_and_checked, an_index_is_sealed_and_checked_body);

    fn the_wrapped_master_needs_its_passphrase_body() {
        let wrapped = wrap_master(&master(), "the right passphrase", &cost()).unwrap();
        assert_eq!(wrapped.len(), 104);
        assert_eq!(unwrap_master(&wrapped, "the right passphrase").unwrap(), master());
        assert!(unwrap_master(&wrapped, "the wrong passphrase").is_err());
        // every byte, one at a time (the cost and the salt included, which are the additional data)
        for at in 0..wrapped.len() {
            let mut changed = wrapped.clone();
            changed[at] ^= 0x01;
            assert!(unwrap_master(&changed, "the right passphrase").is_err(), "a changed byte {} opened", at);
        }
        for len in 0..wrapped.len() {
            assert!(unwrap_master(&wrapped[..len], "the right passphrase").is_err());
        }
        // a cost that a device can't bear, or that makes a guess cheap, is not run
        let salt = crypto::random_salt().unwrap();
        let too_dear = wrap_master_with(&master(), "p", &Kdf { ops: MAX_KDF_OPS, mem: MAX_KDF_MEM + 1 }, &salt, &nonce());
        if let Ok(wrapped) = too_dear {
            assert!(unwrap_master(&wrapped, "p").is_err(), "a gigabyte and a bit was run");
        }
        let cheap = wrap_master_with(&master(), "p", &Kdf { ops: 32768, mem: 1 << 20 }, &salt, &nonce()).unwrap();
        assert!(unwrap_master(&cheap, "p").is_err(), "a cost lower than a vault's was run");
        // two wrappings of one key are two different files (salt and nonce are chosen each time)
        assert_ne!(wrapped, wrap_master(&master(), "the right passphrase", &cost()).unwrap());
    }
    crypto_test!(the_wrapped_master_needs_its_passphrase, the_wrapped_master_needs_its_passphrase_body);
}
