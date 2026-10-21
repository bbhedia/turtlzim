// What the person trusted for a server whose certificate the system does not know (tls.rs): the certificate's fingerprint, for each server (`https://host:port`), in a file in the
// program's own folder. A fingerprint is no secret, and the file is the same promise as the program's settings: whoever can write in the folder can also change the address
// that the program is connected to, and read the token where it is kept in a file. The page never reads or writes the file: it asks, by origin, through the program's commands.
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// The name of the file, in the program's folder.
const FILE: &str = "account-pins.json";

pub struct Pins {
    file: PathBuf,
    /// One change at a time: a read, an edit and a write are not to be interleaved with another's.
    busy: Mutex<()>,
}

impl Pins {
    pub fn new(folder: PathBuf) -> Pins {
        Pins { file: folder.join(FILE), busy: Mutex::new(()) }
    }

    /// Everything that is kept. A file that is not there, or that is not what the program wrote (it was changed by hand, or half written by something else), keeps nothing: a server
    /// is then asked about again, which is the safe way to be wrong.
    fn read(&self) -> Map<String, Value> {
        match fs::read_to_string(&self.file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        }
    }

    fn write(&self, map: &Map<String, Value>) -> Result<(), String> {
        let folder = self.file.parent().ok_or("the program has no folder to keep it in")?;
        fs::create_dir_all(folder).map_err(|error| format!("could not make the program's folder: {error}"))?;
        // (written beside it and put in place: a failure half way leaves the old file, never half of a new one)
        let part = self.file.with_extension("json.part");
        let text = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|error| error.to_string())?;
        fs::write(&part, text).map_err(|error| format!("could not keep what was trusted: {error}"))?;
        fs::rename(&part, &self.file).map_err(|error| format!("could not keep what was trusted: {error}"))
    }

    /// The fingerprint trusted for this server (its origin, as `tls::origin_key` writes it), if there is one that can be read.
    pub fn get(&self, origin: &str) -> Option<String> {
        let _busy = self.busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.read().get(origin).and_then(Value::as_str).filter(|fingerprint| crate::tls::parse_fingerprint(fingerprint).is_some()).map(str::to_string)
    }

    /// Trust this fingerprint for this server, in place of any that was trusted for it.
    pub fn set(&self, origin: &str, fingerprint: &str) -> Result<(), String> {
        let _busy = self.busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut map = self.read();
        map.insert(origin.to_string(), Value::String(fingerprint.to_string()));
        self.write(&map)
    }

    /// Stop trusting anything for this server (that nothing was trusted is not a failure).
    pub fn remove(&self, origin: &str) -> Result<(), String> {
        let _busy = self.busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut map = self.read();
        if map.remove(origin).is_none() {
            return Ok(());
        }
        self.write(&map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "93:B9:5C:F3:A9:7D:EA:48:7F:20:8A:87:CA:FA:03:DB:E1:C3:50:85:3A:D7:A0:64:02:86:98:6D:5C:FF:F5:55";
    const B: &str = "AA:5A:95:F1:7D:5A:44:04:6D:FD:8C:04:E4:F0:16:21:5C:57:E6:13:B6:D0:71:5E:EC:CA:65:ED:8E:DD:12:92";

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("zim-pins-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        folder
    }

    #[test]
    fn keeps_a_fingerprint_for_a_server_and_gives_it_back_to_a_program_that_starts_again() {
        let dir = folder("keeps");
        let pins = Pins::new(dir.clone());
        assert_eq!(pins.get("https://notes.example.org:8443"), None, "nothing is trusted that was not said");
        pins.set("https://notes.example.org:8443", A).unwrap();
        pins.set("https://other.example.org:443", B).unwrap();
        assert_eq!(pins.get("https://notes.example.org:8443").as_deref(), Some(A));
        assert_eq!(pins.get("https://other.example.org:443").as_deref(), Some(B));
        assert_eq!(pins.get("https://notes.example.org:443"), None, "another port is another server");
        assert_eq!(pins.get("https://notes.example.org"), None, "the key is the origin as the program writes it");
        // (a program that starts again reads the file)
        assert_eq!(Pins::new(dir.clone()).get("https://notes.example.org:8443").as_deref(), Some(A));
        // a new one replaces the old one, and the other server's stays
        pins.set("https://notes.example.org:8443", B).unwrap();
        assert_eq!(pins.get("https://notes.example.org:8443").as_deref(), Some(B));
        assert_eq!(pins.get("https://other.example.org:443").as_deref(), Some(B));
        // forgetting one leaves the other, and forgetting what is not there is not a failure
        pins.remove("https://notes.example.org:8443").unwrap();
        assert_eq!(pins.get("https://notes.example.org:8443"), None);
        assert_eq!(pins.get("https://other.example.org:443").as_deref(), Some(B));
        pins.remove("https://notes.example.org:8443").unwrap();
        assert_eq!(Pins::new(folder("never-written")).remove("https://x.example.org:443"), Ok(()));
        // nothing is left beside the file but the file
        let names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec![FILE.to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_nothing_of_a_file_that_is_not_what_it_wrote_and_nothing_that_is_not_a_fingerprint() {
        let dir = folder("garbage");
        fs::create_dir_all(&dir).unwrap();
        for text in ["", "not json", "[]", "\"A\"", "null", "{\"https://notes.example.org:8443\": 5}", "{\"https://notes.example.org:8443\": \"not a fingerprint\"}", "{\"https://notes.example.org:8443\": \"93:B9\"}"] {
            fs::write(dir.join(FILE), text).unwrap();
            assert_eq!(Pins::new(dir.clone()).get("https://notes.example.org:8443"), None, "{text}");
        }
        // and what is wrong in the file does not stop a new one from being kept
        fs::write(dir.join(FILE), "not json").unwrap();
        let pins = Pins::new(dir.clone());
        pins.set("https://notes.example.org:8443", A).unwrap();
        assert_eq!(Pins::new(dir.clone()).get("https://notes.example.org:8443").as_deref(), Some(A));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn says_why_it_could_not_keep_what_was_trusted() {
        // (a folder that is a file: there is nowhere to write in)
        let dir = folder("blocked");
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        fs::write(&dir, "in the way").unwrap();
        let failure = Pins::new(dir.clone()).set("https://notes.example.org:8443", A).unwrap_err();
        assert!(failure.contains("could not"), "{failure}");
        let _ = fs::remove_file(&dir);
    }
}
