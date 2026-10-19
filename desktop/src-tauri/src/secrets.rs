// What must stay secret on this computer (the token that an account gives the program): the system's keychain where there is one (the Credential Manager on Windows, the Keychain on a Mac,
// the Secret Service of the desktop on Linux: GNOME Keyring, KWallet), and, where there is none (a Linux desktop without one, a bare session), a file in the program's own folder that only the
// person's account can read (mode 600). A keychain that can't be reached is not an error to stop at: the file is the same promise as an SSH key's, which is what most programs on such a
// machine have. The page never sees where it was kept; it asks by name.
use std::fs;
use std::path::PathBuf;

/// The service name that entries are kept under in the keychain.
pub const SERVICE: &str = "org.zimnotebook.desktop";

/// Where secrets can be put: the system's keychain, in the program, or a stand-in in a test.
pub trait Keychain: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    /// Remove an entry (one that was never there is not a failure).
    fn remove(&self, name: &str) -> Result<(), String>;
}

/// The system's keychain, by the `keyring` crate.
pub struct SystemKeychain;

impl SystemKeychain {
    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, name).map_err(|error| error.to_string())
    }
}

impl Keychain for SystemKeychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match Self::entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        Self::entry(name)?.set_password(value).map_err(|error| error.to_string())
    }
    fn remove(&self, name: &str) -> Result<(), String> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// What a name may be (it is part of a file's name): letters, digits, dashes.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub struct Secrets {
    keychain: Box<dyn Keychain>,
    /// The folder of the files that stand in for a keychain that is not there.
    folder: PathBuf,
}

impl Secrets {
    pub fn new(keychain: Box<dyn Keychain>, folder: PathBuf) -> Secrets {
        Secrets { keychain, folder }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.folder.join(format!("secret-{name}"))
    }

    fn read_file(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.file(name)).ok().map(|text| text.trim_end().to_string()).filter(|text| !text.is_empty())
    }

    fn write_file(&self, name: &str, value: &str) -> Result<(), String> {
        fs::create_dir_all(&self.folder).map_err(|error| format!("could not make the program's folder: {error}"))?;
        let path = self.file(name);
        // (written beside it and put in place: a failure half way leaves the old one, never half of a new one; made private before anything is in it)
        let part = self.folder.join(format!("secret-{name}.part"));
        let _ = fs::remove_file(&part);
        write_private(&part, value).map_err(|error| format!("could not keep it in {}: {error}", path.display()))?;
        fs::rename(&part, &path).map_err(|error| format!("could not keep it in {}: {error}", path.display()))
    }

    /// The secret, wherever it is kept.
    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        if !valid_name(name) {
            return Err("That is not a name that a secret can have.".into());
        }
        // (a keychain that can't be reached or has nothing is not the end of it: a file may hold what was kept while it was not there)
        match self.keychain.get(name) {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) | Err(_) => Ok(self.read_file(name)),
        }
    }

    /// Keep a secret: in the keychain if there is one that works (and not also in a file: one copy), in the file if not.
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        if !valid_name(name) {
            return Err("That is not a name that a secret can have.".into());
        }
        match self.keychain.set(name, value) {
            Ok(()) => {
                let _ = fs::remove_file(self.file(name));
                Ok(())
            }
            Err(_) => self.write_file(name, value),
        }
    }

    /// Forget a secret, everywhere it is kept. A file that can't be removed is a failure to say (the secret would still be there); a keychain that can't be reached is not (nothing is there).
    pub fn remove(&self, name: &str) -> Result<(), String> {
        if !valid_name(name) {
            return Err("That is not a name that a secret can have.".into());
        }
        let _ = self.keychain.remove(name);
        match fs::remove_file(self.file(name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("could not forget it: {error}")),
        }
    }
}

#[cfg(unix)]
fn write_private(path: &PathBuf, value: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(value.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, value: &str) -> std::io::Result<()> {
    // (a file in the person's own profile folder is theirs by the system's own rules)
    fs::write(path, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// A keychain in memory, that can be made to fail as one that is not there does.
    #[derive(Clone, Default)]
    struct Fake {
        items: Arc<Mutex<HashMap<String, String>>>,
        down: Arc<Mutex<bool>>,
    }
    impl Keychain for Fake {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            if *self.down.lock().unwrap() {
                return Err("no secret service".into());
            }
            Ok(self.items.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if *self.down.lock().unwrap() {
                return Err("no secret service".into());
            }
            self.items.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<(), String> {
            if *self.down.lock().unwrap() {
                return Err("no secret service".into());
            }
            self.items.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn folder(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("zim-secrets-test-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn keeps_a_secret_in_the_keychain_and_in_no_file_when_there_is_one() {
        let (fake, dir) = (Fake::default(), folder("keychain"));
        let secrets = Secrets::new(Box::new(fake.clone()), dir.clone());
        assert_eq!(secrets.get("account-token").unwrap(), None);
        secrets.set("account-token", "t0ken").unwrap();
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("t0ken"));
        assert_eq!(fake.items.lock().unwrap().get("account-token").map(String::as_str), Some("t0ken"));
        assert!(!dir.join("secret-account-token").exists(), "one copy");
        secrets.set("account-token", "second").unwrap();
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("second"));
        secrets.remove("account-token").unwrap();
        assert_eq!(secrets.get("account-token").unwrap(), None);
        secrets.remove("account-token").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_it_in_a_private_file_when_the_keychain_is_not_there() {
        let (fake, dir) = (Fake::default(), folder("file"));
        *fake.down.lock().unwrap() = true;
        let secrets = Secrets::new(Box::new(fake.clone()), dir.clone());
        secrets.set("account-token", "t0ken").unwrap();
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("t0ken"));
        let file = dir.join("secret-account-token");
        assert_eq!(fs::read_to_string(&file).unwrap(), "t0ken");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600, "only the person's account can read it");
        }
        assert!(!dir.join("secret-account-token.part").exists(), "nothing left beside it");
        // a new one replaces the old, and is private too
        secrets.set("account-token", "second").unwrap();
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("second"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // the keychain comes back (the desktop was unlocked): what is in the file is still found, and the next one goes to the keychain and takes the file away
        *fake.down.lock().unwrap() = false;
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("second"));
        secrets.set("account-token", "third").unwrap();
        assert!(!file.exists(), "one copy");
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("third"));
        // forgotten means forgotten, in both places
        fs::create_dir_all(&dir).unwrap();
        fs::write(&file, "old").unwrap();
        secrets.remove("account-token").unwrap();
        assert!(!file.exists());
        assert_eq!(secrets.get("account-token").unwrap(), None);
        // and a keychain that is down while forgetting does not stop the file from going
        *fake.down.lock().unwrap() = true;
        secrets.set("account-token", "again").unwrap();
        secrets.remove("account-token").unwrap();
        assert_eq!(secrets.get("account-token").unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn does_not_make_a_name_into_a_path() {
        let (fake, dir) = (Fake::default(), folder("names"));
        let secrets = Secrets::new(Box::new(fake), dir.clone());
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "a b", "a.b", &"a".repeat(65)] {
            assert!(secrets.get(bad).is_err(), "{bad:?}");
            assert!(secrets.set(bad, "x").is_err(), "{bad:?}");
            assert!(secrets.remove(bad).is_err(), "{bad:?}");
        }
        assert!(!dir.exists(), "nothing was made for them");
    }

    #[test]
    fn treats_an_empty_or_unreadable_file_as_nothing() {
        let (fake, dir) = (Fake::default(), folder("empty"));
        *fake.down.lock().unwrap() = true;
        let secrets = Secrets::new(Box::new(fake), dir.clone());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("secret-account-token"), "").unwrap();
        assert_eq!(secrets.get("account-token").unwrap(), None);
        fs::write(dir.join("secret-account-token"), "t0ken\n").unwrap();
        assert_eq!(secrets.get("account-token").unwrap().as_deref(), Some("t0ken"));
        let _ = fs::remove_dir_all(&dir);
    }
}
