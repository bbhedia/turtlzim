/// Turtl's crypto module. Provides a standard interface for all things crpyto
/// related.

mod error;
mod low;
mod key;

pub use ::crypto::error::{
    CResult,
    CryptoError,
};
pub use ::crypto::low::{
    sha256,
    sha512,
    to_hex,
    from_hex,
    to_base64,
    from_base64,
    HMAC_KEYLEN,
    KEYGEN_SALT_LEN,
    KEYGEN_OPS_DEFAULT,
    KEYGEN_MEM_DEFAULT,
    random_salt,
};
pub use ::crypto::low::chacha20poly1305::{random_nonce, random_key, noncelen, keylen};
pub use ::crypto::key::Key;
// Must be called and awaited exactly once before any other crypto:: function
// is used on wasm32 -- see `low::init_wasm_crypto`'s doc comment.
#[cfg(target_arch = "wasm32")]
pub use ::crypto::low::init_wasm_crypto;

/// Stores our current crypto version. This gets encoded into a header in the
/// ciphertext and lets the crypto module know how to handle the message.
const CRYPTO_VERSION: u16 = 6;

/// Stores the available algorithms for symmetric crypto.
const SYM_ALGORITHM: [&'static str; 1] = ["chacha20poly1305"];

/// Find the position of a static string in an array of static strings
fn find_index(arr: &[&'static str], val: &str) -> CResult<usize> {
    for i in 0..arr.len() {
        if val == arr[i] { return Ok(i) }
    }
    Err(CryptoError::Msg(format!("not found: {}", val)))
}

/// Describes how we want to run our encryption.
#[derive(Debug)]
pub struct CryptoOp {
    algorithm: &'static str,
    nonce: Option<Vec<u8>>,
}
impl CryptoOp {
    /// Create a new crypto op with a cipher/blockmode
    pub fn new(algorithm: &'static str) -> CResult<CryptoOp> {
        find_index(&SYM_ALGORITHM, algorithm)?;
        Ok(CryptoOp { algorithm: algorithm, nonce: None })
    }

    /// Create a new crypto op with a algorithm/nonce
    pub fn new_with_nonce(algorithm: &'static str, nonce: Vec<u8>) -> CResult<CryptoOp> {
        let mut op = CryptoOp::new(algorithm)?;
        op.nonce = Some(nonce);
        Ok(op)
    }
}

/// Describes some meta about our payload. This includes the version
/// algorithm used.
#[derive(Debug)]
pub struct PayloadDescription {
    pub algorithm: u8,
}
impl PayloadDescription {
    /// Create a new PayloadDescription from a crypto version and some other data
    pub fn new(_crypto_version: u16, algorithm: &str) -> CResult<PayloadDescription> {
        let desc: Vec<u8> = vec![find_index(&SYM_ALGORITHM, algorithm)? as u8];
        Ok(PayloadDescription::from(desc.as_slice())?)
    }

    /// Convert a byte vector into a PayloadDescription object
    pub fn from(data: &[u8]) -> CResult<PayloadDescription> {
        if data.len() < 1 { return Err(CryptoError::Msg(format!("PayloadDescription::from - bad desc length (< 2)"))) }
        let algorithm = data[0];
        Ok(PayloadDescription {
            algorithm: algorithm,
        })
    }

    /// Covert this payload description into a byte vector
    pub fn as_vec(&self) -> Vec<u8> {
        vec![self.algorithm]
    }

    /// Get the payload description's size
    pub fn len(&self) -> usize {
        self.as_vec().len()
    }
}

/// Holds a deserialized description of our ciphertext.
#[derive(Debug)]
pub struct CryptoData {
    pub version: u16,
    pub desc: PayloadDescription,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

impl CryptoData {
    /// Create a new CryptoData object from its parts
    pub fn new(version: u16, desc: PayloadDescription, nonce: Vec<u8>, ciphertext: Vec<u8>) -> CryptoData {
        CryptoData {
            version: version,
            desc: desc,
            nonce: nonce,
            ciphertext: ciphertext,
        }
    }

    /// Returns the estimated serialized size of this CryptoData
    pub fn len(&self) -> usize {
        let version_size: usize = 2;
        return (version_size + self.desc.len() + self.nonce.len() + self.ciphertext.len()) as usize;
    }
}

/// Deserialize a serialized cryptographic message. Basically, each piece of
/// crypto data in Turtl has a header, followed by N bytes of ciphertext in
/// the following format:
///
///   |-2 bytes-| |-1 byte----| |-N bytes-----------| |-1 byte-----| |-N bytes-| |-N bytes--|
///   | version | |desc length| |payload description| |nonce length| |  nonce  | |ciphertext|
///
/// - `version` tells us the serialization version. although it will probably
///   not get over 255, it has two bytes just in case. never say never.
/// - `desc length` is the length of the payload description, which may change
///   in length from version to version.
/// - `payload description` tells us what algorithm/format the encryption uses.
///   This holds 1-byte array indexes for our crypto values (SYM_ALGORITHM),
///   which tells us the cipher, block mode, etc (and how to decrypt this data).
/// - `nonce length` is the length of the nonce
/// - `nonce` is the initial vector of the payload.
/// - `ciphertext` is our actual encrypted data. DUUUuuuUUUHHH
///
pub fn deserialize(mut serialized: Vec<u8>) -> CResult<CryptoData> {
    let mut idx: usize = 0;
    let lengtherr = Err(CryptoError::BadData(format!("crypto::deserialize() -- bad data length while deserializing")));

    if serialized.len() <= 2 { return lengtherr; }
    let version: u16 = ((serialized[idx] as u16) << 8) + (serialized[idx + 1] as u16);
    idx += 2;

    let desc_struct = {
        if serialized.len() <= (idx + 1) { return lengtherr; }
        let desc_length = serialized[idx];
        idx += 1;
        if serialized.len() <= (idx + (desc_length as usize)) { return lengtherr; }
        let desc = &serialized[idx..(idx + (desc_length as usize))];
        idx += desc_length as usize;
        PayloadDescription::from(desc)?
    };

    if serialized.len() <= idx { return lengtherr; }
    let nonce_length = serialized[idx] as usize;
    idx += 1;
    let nonce_idx = idx + nonce_length;
    if nonce_idx >= serialized.len() {
        return Err(CryptoError::BadData(String::from("crypto::deserialize() -- malformed data passed")));
    }
    let nonce = Vec::from(&serialized[idx..nonce_idx]);
    idx += nonce_length;

    if serialized.len() <= idx { return lengtherr; }
    // non-copying conversion into a vec
    let ciphertext: Vec<u8> = serialized.drain(idx..).collect();

    Ok(CryptoData::new(version, desc_struct, nonce, ciphertext))
}

/// Serialize a CryptoData container into a raw header vector. This is useful
/// for extracting authentication data.
pub fn serialize_header(data: &CryptoData) -> CResult<Vec<u8>> {
    let mut ser: Vec<u8> = Vec::with_capacity(data.len());

    // add the two-byte version
    ser.push((data.version >> 8) as u8);
    ser.push((data.version & 0xFF) as u8);

    // add description length and description
    ser.push(data.desc.len() as u8);
    ser.append(&mut data.desc.as_vec().clone());

    // add the nonce
    ser.push(data.nonce.len() as u8);
    ser.append(&mut data.nonce.clone());

    Ok(ser)
}

/// Serialize a CryptoData container into a vector of bytes. For more info on
/// the different serialization formats, check out deserialize().
pub fn serialize(data: &mut CryptoData) -> CResult<Vec<u8>> {
    // grab the raw header
    let mut ser = serialize_header(data)?;

    // lastly, our ciphertext
    ser.append(&mut data.ciphertext);

    Ok(ser)
}

/// Decrypt a message, given a key and the ciphertext. The ciphertext should
/// contain *all* the data needed to decrypt the message encoded in a header
/// (see deserialize() for more info).
pub fn decrypt(key: &Key, ciphertext: Vec<u8>) -> CResult<Vec<u8>> {
    let deserialized = deserialize(ciphertext)?;
    let desc = &deserialized.desc;
    let nonce = &deserialized.nonce;
    let ciphertext = &deserialized.ciphertext;
    let auth: Vec<u8> = serialize_header(&deserialized)?;
    let decrypted = match SYM_ALGORITHM[desc.algorithm as usize] {
        "chacha20poly1305" => {
            low::chacha20poly1305::decrypt(key.data().as_slice(), nonce.as_slice(), auth.as_slice(), ciphertext.as_slice())?
        },
        _ => {
            return Err(CryptoError::NotImplemented(format!("the algorithm in this payload was not found: {}", desc.algorithm)));
        }
    };
    Ok(decrypted)
}

/// Encrypt a message, given a key and the plaintext. This returns the
/// ciphertext serialized via Turtl serialization format (see deserialize() for
/// more info).
///
/// Note that this function *ONLY* supports encrypting the current crypto
/// version (CRYPTO_VERSION). The idea is that later versions are most likely
/// more secure or correct than earlier versions, so we just don't allow going
/// back in time (although decrypt() supports all previous versions).
pub fn encrypt(key: &Key, plaintext: Vec<u8>, op: CryptoOp) -> CResult<Vec<u8>> {
    let version = CRYPTO_VERSION;
    match op.algorithm {
        "chacha20poly1305" => {
            let nonce = match op.nonce {
                Some(x) => x,
                None => low::chacha20poly1305::random_nonce()?,
            };
            let desc = PayloadDescription::new(version, op.algorithm)?;
            let mut data = CryptoData::new(version, desc, nonce, Vec::new());
            let auth = serialize_header(&data)?;
            data.ciphertext = low::chacha20poly1305::encrypt(key.data().as_slice(), data.nonce.as_slice(), auth.as_slice(), plaintext.as_slice())?;
            Ok(serialize(&mut data)?)
        }
        _ => {
            return Err(CryptoError::NotImplemented(format!("mode not implemented: {} (try \"chacha20poly1305\")", op.algorithm)));
        }
    }
}

/// Generate a key given a password and a salt
pub fn gen_key(password: &[u8], salt: &[u8], cpu: usize, mem: usize) -> CResult<Key> {
    Ok(Key::new(low::gen_key(password, salt, cpu, mem)?))
}

/// Generate a random hex string (64 bytes).
pub fn random_hash() -> CResult<String> {
    low::to_hex(&low::rand_bytes(32)?)
}

pub mod asym {
    use ::crypto::key::Key;
    use ::crypto::error::{CResult, CryptoError};
    use ::crypto::low::asym as low_asym;

    /// Stores our current crypto version. This gets encoded into a header in the
    /// ciphertext and lets the crypto module know how to handle the message.
    const CRYPTO_VERSION: u8 = 3;

    /// Serialize an asym message
    fn serialize(version: u8, mut data: Vec<u8>) -> Vec<u8> {
        let mut ser: Vec<u8> = Vec::with_capacity(data.len() + 1);
        ser.push(version);
        ser.append(&mut data);
        ser
    }

    fn deserialize(mut serialized: Vec<u8>) -> (u8, Vec<u8>) {
        let version = serialized[0];
        let data = serialized.drain(1..).collect();
        (version, data)
    }

    /// Generate an asym keypair.
    pub fn keygen() -> CResult<(Key, Key)> {
        let (pk, sk) = low_asym::keygen()?;
        // wrap our Vecs in the Key type
        Ok((Key::new(pk), Key::new(sk)))
    }

    /// Asymmetrically encrypt a message with someone's public key
    pub fn encrypt(their_pubkey: &Key, plaintext: Vec<u8>) -> CResult<Vec<u8>> {
        let encrypted = low_asym::encrypt(their_pubkey.data().as_slice(), plaintext.as_slice())?;
        Ok(serialize(CRYPTO_VERSION, encrypted))
    }

    /// Asymmetrically decrypt a message with our public/private keypair
    pub fn decrypt(our_pubkey: &Key, our_privkey: &Key, message: Vec<u8>) -> CResult<Vec<u8>> {
        let (version, ciphertext) = deserialize(message);
        match version {
            3 => low_asym::decrypt(our_pubkey.data().as_slice(), our_privkey.data().as_slice(), ciphertext.as_slice()),
            _ => Err(CryptoError::NotImplemented(format!("crypto::asym::decrypt() -- found version {} (which is not implemented)", version))),
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tests for our high-level Crypto module interface.

    use super::*;
    use ::crypto::low::chacha20poly1305 as aead;

    const TEST_ITERATIONS: usize = 32;

    #[test]
    /// Makes sure our cipher/block/padding indexes are correct. New values can be
    /// added to these arrays, but *MUST* be tested here. Note that we also test for
    /// existence of specific values at specific indexes so re-ordering of these
    /// arrays will make our test fail.
    fn indexes_are_correct() {
        assert_eq!(super::SYM_ALGORITHM.len(), 1);
        assert_eq!(super::SYM_ALGORITHM[0], "chacha20poly1305");
    }

    #[test]
    fn can_gen_keys() {
        let username = String::from("andrew@thillygooth.com");
        let password = String::from("this is definitely not the password i use for my bank account. no sir.");
        let salt = Vec::from(&(sha512(username.as_bytes()).unwrap())[0..KEYGEN_SALT_LEN]);

        let key = gen_key(password.as_bytes(), salt.as_slice(), KEYGEN_OPS_DEFAULT, KEYGEN_MEM_DEFAULT).unwrap();
        let keystr = to_hex(key.data()).unwrap();
        assert_eq!(keystr, "f36850e9bd90afc3413a89693bf71ebdf347f3727bad9b4487e249bb21ca28f1");
    }

    #[test]
    fn can_decrypt_latest() {
        let key = Key::new(from_base64(&String::from("2gtrzmvEQkfK9Lq+0eGqLjDrmlKBabp7T212Zdv35T0=")).unwrap());
        let payload = from_base64(&String::from("AAYBAAzGNuOg4N1zkQ2BlAiBbjNiYibICOs1NW18Jh/QfvdS+fR70+5kMnNCjXUSND05fU3m/FrcFZKPd3yQAl5gsP+4hWqkbWd+6/ip6HISeEz0NPBNTCWedSVgKYiEdnORSoiunl4l61vBmsyzQGnQl8fCYuerTLeGpq6j6Y5fBVmqmjWbmc5zeKqmg+LTfFUq9iNg5HoUPVKfjVm1aYlFG/fjMSk25j5zIgecFHAJOlQqtHXXPPCxwYLBoHBPsZE3kMu8jzE1QO8SAPOPyp2o3pD8fX1OhvqRHL/W34dqQzasmrscgvdvAy69l6nwbByOsjwvNSm2jWiNWGqFqxLgLXLy00r8A3E3hBDtQur4uo6Vs9ZSYn4mfLjEAyhyUsZeaoti8pKK5FVcJA9a//Blztbdmd8SPysXxks/6RvHIjy+aRCVxs/8Bw2Mv+AiSZ59dohNN4OUoVy3hNXk0RfdCDakw5AVq7xocAwmMLZeoWUgUt+Nb8ntt5W8KpfZVGMuxqIQoJoRMG7kf6TEHpL4vBOmosV0MwtLWkXwyXsx+zkP3GRw9mIcCkm5wEWpELYYzrOLmVQs4QHMetWsmyfTFOFlzVFPl7ctKlKuUOfbKETmrafvCNmoeOAWn58CXeEsD06ejrlg9zuPf5Vc3eIMSJ+EKIy8/eMLLFIDEzYkutqOfZoG6LJgevbgivLV7oXnG4kBF5pGVvwnpED4fTUFCFnc+MWATCN9aIJ58aLIdmF7TLYQwwXwNyyo9MvTJn/sEVjsbX/kpYrtknW1pjJ44e11du2Q5GpJXA4630g7BOOxooYTQgumoo/P3pPJnLjt9TJWPw7Q2h5rb2tqJowhltN19upncbOwMl1HPJcCqtOZOmttskMiDZGAjytiGOuD15TnfDUoZu3b97x0O6Nzm3RxGGBg4kQjC0q0RW0700EGGeCaiq9XAfUFIsS5XQ==")).unwrap();
        let plain = decrypt(&key, payload).unwrap();
        let plain_str = String::from_utf8(plain).unwrap();
        assert_eq!(plain_str, r#"{"title":"libertarian quotes","body":"Moreover, the institution of child labor is an honorable one, with a long and glorious history of good works. And the villains of the piece are not the employers, but rather those who prohibit the free market in child labor. These do-gooders are responsible for the untold immiseration of those who are thus forced out of employment. Although the harm done was greater in the past, when great poverty made widespread child labor necessary, there are still people in dire straits today. Present prohibitions of child labor are thus an unconscionable interference with their lives.","tags":["moron"],"mod":1468007942,"created":1468007942.493,"keys":[]}"#);
    }

    #[test]
    fn catches_truncated_ciphertext() {
        let key = Key::new(from_base64(&String::from("2gtrzmvEQkfK9Lq+0eGqLjDrmlKBabp7T212Zdv35T0=")).unwrap());
        let payload = from_base64(&String::from("AAYBAA")).unwrap();
        let err = decrypt(&key, payload);
        match err {
            Err(CryptoError::BadData(x)) => {
                assert!(x.contains("bad data length"));
            }
            _ => { panic!("Unexpected error: {:?}", err); }
        }
        let payload = from_base64(&String::from("AAYBAAzGNuOg4N1z")).unwrap();
        let err = decrypt(&key, payload);
        match err {
            Err(CryptoError::BadData(x)) => {
                assert!(x.contains("malformed data"));
            }
            _ => { panic!("Unexpected error: {:?}", err); }
        }
        let key = Key::new(from_base64(&String::from("2gtrzmvEQkfK9Lq+0eGqLjDrmlKBabp7T212Zdv35T0=")).unwrap());
        let payload_str = String::from("[object Object]");
        let payload = Vec::from(payload_str.as_bytes());
        let err = decrypt(&key, payload);
        match err {
            Err(CryptoError::BadData(x)) => {
                assert!(x.contains("bad data length"));
            }
            _ => { panic!("Unexpected error: {:?}", err); }
        }
    }

    #[test]
    fn can_encrypt_latest() {
        let key = Key::new(from_base64(&String::from("2gtrzmvEQkfK9Lq+0eGqLjDrmlKBabp7T212Zdv35T0=")).unwrap());
        let nonce = Vec::from(&sha512(String::from("omg wtff").as_bytes()).unwrap()[0..aead::noncelen()]);
        let plain = String::from(r#"{"title":"libertarian quotes","body":"Moreover, the institution of child labor is an honorable one, with a long and glorious history of good works. And the villains of the piece are not the employers, but rather those who prohibit the free market in child labor. These do-gooders are responsible for the untold immiseration of those who are thus forced out of employment. Although the harm done was greater in the past, when great poverty made widespread child labor necessary, there are still people in dire straits today. Present prohibitions of child labor are thus an unconscionable interference with their lives.","tags":["moron"],"mod":1468007942,"created":1468007942.493,"keys":[]}"#);
        let op = CryptoOp::new_with_nonce("chacha20poly1305", nonce).unwrap();
        let enc = encrypt(&key, Vec::from(plain.as_bytes()), op).unwrap();
        let enc_str = to_base64(&enc).unwrap();
        assert_eq!(enc_str, "AAYBAAzGNuOg4N1zkQ2BlAiBbjNiYibICOs1NW18Jh/QfvdS+fR70+5kMnNCjXUSND05fU3m/FrcFZKPd3yQAl5gsP+4hWqkbWd+6/ip6HISeEz0NPBNTCWedSVgKYiEdnORSoiunl4l61vBmsyzQGnQl8fCYuerTLeGpq6j6Y5fBVmqmjWbmc5zeKqmg+LTfFUq9iNg5HoUPVKfjVm1aYlFG/fjMSk25j5zIgecFHAJOlQqtHXXPPCxwYLBoHBPsZE3kMu8jzE1QO8SAPOPyp2o3pD8fX1OhvqRHL/W34dqQzasmrscgvdvAy69l6nwbByOsjwvNSm2jWiNWGqFqxLgLXLy00r8A3E3hBDtQur4uo6Vs9ZSYn4mfLjEAyhyUsZeaoti8pKK5FVcJA9a//Blztbdmd8SPysXxks/6RvHIjy+aRCVxs/8Bw2Mv+AiSZ59dohNN4OUoVy3hNXk0RfdCDakw5AVq7xocAwmMLZeoWUgUt+Nb8ntt5W8KpfZVGMuxqIQoJoRMG7kf6TEHpL4vBOmosV0MwtLWkXwyXsx+zkP3GRw9mIcCkm5wEWpELYYzrOLmVQs4QHMetWsmyfTFOFlzVFPl7ctKlKuUOfbKETmrafvCNmoeOAWn58CXeEsD06ejrlg9zuPf5Vc3eIMSJ+EKIy8/eMLLFIDEzYkutqOfZoG6LJgevbgivLV7oXnG4kBF5pGVvwnpED4fTUFCFnc+MWATCN9aIJ58aLIdmF7TLYQwwXwNyyo9MvTJn/sEVjsbX/kpYrtknW1pjJ44e11du2Q5GpJXA4630g7BOOxooYTQgumoo/P3pPJnLjt9TJWPw7Q2h5rb2tqJowhltN19upncbOwMl1HPJcCqtOZOmttskMiDZGAjytiGOuD15TnfDUoZu3b97x0O6Nzm3RxGGBg4kQjC0q0RW0700EGGeCaiq9XAfUFIsS5XQ==");
    }

    #[test]
    fn can_gen_random_keys() {
        // test a number of hashes
        for _ in 0..TEST_ITERATIONS {
            let key = Key::random().unwrap();
            assert_eq!(key.data().len(), aead::keylen());
        }
    }

    #[test]
    fn can_gen_random_nonce() {
        // test a number of hashes
        for _ in 0..TEST_ITERATIONS {
            let nonce = aead::random_nonce().unwrap();
            assert_eq!(nonce.len(), aead::noncelen());
        }
    }

    #[test]
    fn can_gen_random_hash() {
        // test a number of hashes
        for _ in 0..TEST_ITERATIONS {
            let hash = random_hash().unwrap();
            assert_eq!(hash.len(), 64);
            for chr in hash.chars() {
                let cint = chr as u32;
                assert!(
                    (cint >= ('0' as u32) && cint <= ('9' as u32)) ||
                    (cint >= ('a' as u32) && cint <= ('f' as u32))
                );
            }
        }
    }

    #[test]
    fn asym_crypto() {
        // test decrypting pre-computed val from js
        let ciphertext = from_base64(&String::from(r#"A3eNneAydRaXiMB0886wo3sTTAxHcyM7JpaLN4z2rqQRyxUPq/eKrWHyF2/1wC9gfmw5t7lQ6KhT+tSbYTAHQb2EJ3NvwGRyeQ5SXId7RYSAeaoizSyT8JfEI91hyRde3sC5C00xYn60LYjt"#)).unwrap();
        let pk = Key::new(from_base64(&String::from(r#"3KhS3n3QlT/w7rE8hwwq/HNnVxlgzkphsqYKRAzbNGg="#)).unwrap());
        let sk = Key::new(from_base64(&String::from(r#"ZZN2wHM5T7tUugDGUpMbMB6lI/o5S9AVxjntFjdO+/0="#)).unwrap());

        let msg = asym::decrypt(&pk, &sk, ciphertext).unwrap();
        let msg_str = String::from_utf8(msg).unwrap();
        assert_eq!(msg_str, "and if you ever put your god damn hands on my wife again...");

        // test encrypt/decrypt cycle
        let (her_pk, her_sk) = asym::keygen().unwrap();
        let message = String::from("I'M NOT A PERVERT");
        let encrypted = asym::encrypt(&her_pk, Vec::from(message.as_bytes())).unwrap();
        let decrypted = asym::decrypt(&her_pk, &her_sk, encrypted).unwrap();
        let decrypted_str = String::from_utf8(decrypted).unwrap();
        assert_eq!(decrypted_str, "I'M NOT A PERVERT");

        // test error condition
        let (her_pk, her_sk) = asym::keygen().unwrap();
        let message = String::from("I'M NOT A PERVERT");
        let mut encrypted = asym::encrypt(&her_pk, Vec::from(message.as_bytes())).unwrap();
        // modify the data, should break the crypto
        if encrypted[4] == 0 { encrypted[4] = 1; }
        else { encrypted[4] = 0; }
        let res = asym::decrypt(&her_pk, &her_sk, encrypted);
        assert!(res.is_err());
    }

    #[test]
    /// Golden-vector generator for the WASM crypto proof-of-concept
    /// (see docs/wasm-port-plan.md, "step 2: crypto PoC").
    ///
    /// This is NOT a correctness assertion against fixed expected output --
    /// it drives the real, native `crypto::encrypt()` path (the same one
    /// every note/board/space/keychain-key encryption in this crate goes
    /// through) over a spread of (key, plaintext) pairs and dumps
    /// `{key_hex, plaintext_hex, envelope_hex}` triples as JSON to
    /// `core/wasm-crypto-poc/test/golden_vectors.json`, so a wasm-bindgen +
    /// libsodium.js reimplementation of the envelope format can be checked
    /// for byte-exact parity against real native output (see
    /// `core/wasm-crypto-poc/test/run_test.js`, which parses each envelope
    /// to pull out the nonce libsodium/`encrypt()` chose at random here,
    /// then feeds `(key, nonce, plaintext)` into the wasm build's
    /// `wasm_encrypt` and diffs the raw bytes against `envelope_hex`).
    fn generate_wasm_golden_vectors() {
        use ::std::fs;
        use ::std::path::Path;

        fn make_vector(name: &'static str, key: Key, plaintext: Vec<u8>) -> ::serde_json::Value {
            let op = CryptoOp::new("chacha20poly1305").unwrap();
            let envelope = encrypt(&key, plaintext.clone(), op).unwrap();
            let key_hex = to_hex(key.data()).unwrap();
            let plaintext_hex = to_hex(&plaintext).unwrap();
            let envelope_hex = to_hex(&envelope).unwrap();
            println!(
                "[{}] key={} plaintext_len={} envelope_len={}\n  plaintext={}\n  envelope ={}",
                name, key_hex, plaintext.len(), envelope.len(), plaintext_hex, envelope_hex
            );
            json!({
                "name": name,
                "key_hex": key_hex,
                "plaintext_hex": plaintext_hex,
                "envelope_hex": envelope_hex,
            })
        }

        // a fixed (non-random) key, reused for a couple of vectors so we
        // also cover "same key, different plaintext"
        let fixed_key = Key::new(from_base64(&String::from("2gtrzmvEQkfK9Lq+0eGqLjDrmlKBabp7T212Zdv35T0=")).unwrap());

        // 256 bytes covering every possible byte value once
        let byte_ramp_256: Vec<u8> = (0..=255u8).collect();

        // deterministic 4KB "long plaintext" ramp pattern
        let long_4kb: Vec<u8> = (0..4096usize).map(|i| (i % 256) as u8).collect();

        // 8KB of repeated realistic text
        let paragraph = "The quick brown fox jumps over the lazy dog. Zim wiki notes, encrypted end-to-end. ";
        let mut long_8kb: Vec<u8> = Vec::new();
        while long_8kb.len() < 8192 {
            long_8kb.extend_from_slice(paragraph.as_bytes());
        }
        long_8kb.truncate(8192);

        // bytes with embedded NUL and 0xFF bytes mixed with ASCII
        let embedded_nulls: Vec<u8> = vec![0x00, 0x41, 0x00, 0xFF, 0xFE, 0x42, 0x00, 0x00, 0xFF, 0x43];

        // non-ASCII UTF-8 (accented latin, CJK, emoji)
        let non_ascii = String::from("caf\u{00e9} \u{4f60}\u{597d} \u{1f512}\u{1f5dd}\u{fe0f} \u{00fc}\u{00f6}\u{00e4}");

        // real random data, several KB
        let long_random_16kb = low::rand_bytes(16384).unwrap();
        let binary_random_1kb = low::rand_bytes(1024).unwrap();

        // a realistic small note JSON body
        let short_json_note = String::from(r#"{"title":"grocery list","body":"- eggs\n- milk\n[ ] buy stamps","tags":["home"],"mod":1735000000,"created":1735000000.0,"keys":[]}"#);

        let mut vectors: Vec<::serde_json::Value> = Vec::new();
        vectors.push(make_vector("empty", Key::random().unwrap(), Vec::new()));
        vectors.push(make_vector("single_byte", Key::random().unwrap(), vec![0x41]));
        vectors.push(make_vector("short_ascii", fixed_key.clone(), Vec::from("The quick brown fox jumps over the lazy dog".as_bytes())));
        vectors.push(make_vector("short_json_note", Key::random().unwrap(), Vec::from(short_json_note.as_bytes())));
        vectors.push(make_vector("byte_ramp_256", Key::random().unwrap(), byte_ramp_256));
        vectors.push(make_vector("non_ascii_utf8", Key::random().unwrap(), Vec::from(non_ascii.as_bytes())));
        vectors.push(make_vector("embedded_nulls", Key::random().unwrap(), embedded_nulls));
        vectors.push(make_vector("long_4kb", Key::random().unwrap(), long_4kb));
        vectors.push(make_vector("long_8kb_text", fixed_key.clone(), long_8kb));
        vectors.push(make_vector("long_random_16kb", Key::random().unwrap(), long_random_16kb));
        vectors.push(make_vector("binary_random_1kb", Key::random().unwrap(), binary_random_1kb));

        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let out_dir = Path::new(manifest_dir).join("..").join("wasm-crypto-poc").join("test");
        fs::create_dir_all(&out_dir).expect("failed to create wasm-crypto-poc/test output dir");
        let out_path = out_dir.join("golden_vectors.json");
        let json_str = ::serde_json::to_string_pretty(&vectors).unwrap();
        fs::write(&out_path, json_str).expect("failed to write golden_vectors.json");
        println!("wrote {} golden vectors to {}", vectors.len(), out_path.display());
    }
}

/// Real-wasm-execution parity tests: proves `crypto::encrypt()`/
/// `crypto::decrypt()` -- this file's actual public encryption API, used
/// throughout the whole crate for real notes/boards/keychain, NOT a
/// reimplementation of it -- produce byte-identical ciphertext to native
/// `sodiumoxide` when run for real on `wasm32-unknown-unknown`, via the real
/// `libsodium-wrappers` JS bridge (`crypto::low`'s `wasm_bridge`/
/// `init_wasm_crypto()`, see low.rs). Run with:
///
///   cd core/turtl-core-rs && wasm-pack test --node
///
/// The golden vectors below are literal (key_hex, plaintext_hex,
/// envelope_hex) triples captured from a real run of the native
/// `crypto::tests::generate_wasm_golden_vectors()` test above (see that test,
/// and `core/wasm-crypto-poc/test/golden_vectors.json`, for how these are
/// produced/regenerated). They're hardcoded here rather than regenerated at
/// test time: native `sodiumoxide` doesn't exist on this target (see
/// `#[cfg(not(target_arch = "wasm32"))]` on `sodiumoxide` throughout low.rs),
/// and wasm32 has no filesystem to read a JSON file from in a real browser
/// context anyway.
///
/// NOTE on why these tests look the way they do: `turtl_core` is a Rust
/// 2015-edition crate (see `crypto::low::InitCryptoFuture`'s doc comment for
/// why bumping the edition to get `async fn`/`.await` sugar isn't a safe,
/// narrow change here), so plain `#[wasm_bindgen_test] async fn ...` tests
/// (which need that syntax) aren't available. `wasm-bindgen-test` also
/// supports `#[wasm_bindgen_test(async)]` on an ordinary (non-`async`) `fn`
/// that *returns* a `Future`-implementing value -- its runtime awaits that
/// value itself (inside `wasm-bindgen-test`'s own, differently-edition'd
/// crate), so no `async`/`.await` syntax is needed on our side at all. Each
/// test below returns a `ThenReady` (below), a tiny hand-written `Future`
/// that awaits the real `crypto::init_wasm_crypto()` (this file's actual
/// public wasm32 init entry point, not a reimplementation) and then runs a
/// plain synchronous assertion closure -- since every crypto:: call after
/// init is itself synchronous, that's the only `Future` needed anywhere in
/// this module.
#[cfg(all(test, target_arch = "wasm32"))]
mod wasm_parity_tests {
    use super::*;
    use ::wasm_bindgen_test::*;

    // No `wasm_bindgen_test_configure!` call needed: Node (this suite runs via
    // `wasm-pack test --node`) is the default target when neither
    // `run_in_browser` nor `run_in_worker`/`run_in_dedicated_worker` is set.

    /// Awaits the real `crypto::init_wasm_crypto()` Promise, then runs a
    /// synchronous closure. See the module doc comment above for why this
    /// hand-written `Future` exists instead of `async fn`/`.await`.
    struct ThenReady {
        ready: ::wasm_bindgen_futures::JsFuture,
        body: Option<Box<dyn FnOnce()>>,
    }

    impl ThenReady {
        fn new<F: FnOnce() + 'static>(body: F) -> ThenReady {
            ThenReady {
                ready: ::wasm_bindgen_futures::JsFuture::from(init_wasm_crypto()),
                body: Some(Box::new(body)),
            }
        }
    }

    impl ::std::future::Future for ThenReady {
        type Output = ();

        fn poll(self: ::std::pin::Pin<&mut Self>, cx: &mut ::std::task::Context) -> ::std::task::Poll<()> {
            let this = self.get_mut();
            match ::std::pin::Pin::new(&mut this.ready).poll(cx) {
                ::std::task::Poll::Ready(result) => {
                    result.expect("init_wasm_crypto() promise rejected");
                    let body = this.body.take().expect("ThenReady polled after completion");
                    body();
                    ::std::task::Poll::Ready(())
                }
                ::std::task::Poll::Pending => ::std::task::Poll::Pending,
            }
        }
    }

    /// (name, key_hex, plaintext_hex, envelope_hex). Covers an empty
    /// plaintext (edge case: zero-length AEAD input), a plain ASCII short
    /// note body, and one with embedded NUL/0xFF bytes.
    const GOLDEN_VECTORS: &[(&str, &str, &str, &str)] = &[
        (
            "empty",
            "b24815ffa0541d545398b9040604bb0cef1b9a9bbb76475f6d5839ed94ff19ed",
            "",
            "000601000c64c4fc4ed801389768d21af52aa6afb1ad2c637dc90c16b9f03ab6c1",
        ),
        (
            "short_ascii",
            "da0b6bce6bc44247caf4babed1e1aa2e30eb9a528169ba7b4f6d7665dbf7e53d",
            "54686520717569636b2062726f776e20666f78206a756d7073206f76657220746865206c617a7920646f67",
            "000601000c884dedbb92466605629e022bc32b20a9b02a85d14e00d575c69a4fbb89c51893b99c5b88770c3470e24e8265ec26108d9e4f40240092471564065e80fae1cd6edc974447c72a1f",
        ),
        (
            "embedded_nulls",
            "6279d53ef447d8c56df9bc4952a7c1ab55b0d9b31d016838526bf4672fadb9e7",
            "004100fffe420000ff43",
            "000601000c9cbbe076ac15697cbcbe43d7885f1fcdfd18aa83f44ee94e4cf80e8d1bbb925a64fb2fc4ee0e",
        ),
    ];

    /// Byte-exact parity, both directions, for every golden vector:
    ///   1. `crypto::encrypt()` on wasm32, forced to reuse the exact nonce
    ///      native picked at random (extracted via `crypto::deserialize()`
    ///      -- the same trick `core/wasm-crypto-poc` used), produces the
    ///      EXACT SAME envelope bytes as real native `crypto::encrypt()` did.
    ///   2. `crypto::decrypt()` on wasm32 recovers the exact original
    ///      plaintext bytes from that real native envelope.
    #[wasm_bindgen_test(async)]
    fn wasm_matches_native_golden_vectors() -> ThenReady {
        ThenReady::new(|| {
            for &(name, key_hex, plaintext_hex, envelope_hex) in GOLDEN_VECTORS {
                let key = Key::new(from_hex(&String::from(key_hex)).unwrap());
                let plaintext = from_hex(&String::from(plaintext_hex)).unwrap();
                let native_envelope = from_hex(&String::from(envelope_hex)).unwrap();

                // pull the nonce native encrypt() picked at random back out of
                // its own envelope, so we can force wasm's encrypt() to reuse
                // it for a fair byte-for-byte comparison.
                let parsed = deserialize(native_envelope.clone())
                    .unwrap_or_else(|e| panic!("[{}] failed to parse native envelope: {}", name, e));
                let nonce = parsed.nonce.clone();

                let op = CryptoOp::new_with_nonce("chacha20poly1305", nonce)
                    .unwrap_or_else(|e| panic!("[{}] CryptoOp::new_with_nonce failed: {}", name, e));
                let wasm_envelope = encrypt(&key, plaintext.clone(), op)
                    .unwrap_or_else(|e| panic!("[{}] wasm crypto::encrypt() failed: {}", name, e));
                assert_eq!(
                    wasm_envelope, native_envelope,
                    "[{}] wasm-produced envelope does not byte-match the real native envelope", name
                );

                let wasm_plaintext = decrypt(&key, native_envelope.clone())
                    .unwrap_or_else(|e| panic!("[{}] wasm crypto::decrypt() of native envelope failed: {}", name, e));
                assert_eq!(
                    wasm_plaintext, plaintext,
                    "[{}] wasm-decrypted plaintext does not byte-match the original", name
                );
            }
        })
    }

    /// Full round trip using wasm32's own random nonce (i.e. `rand_bytes()`
    /// via the real libsodium.js bridge, not a forced/extracted one):
    /// encrypt-then-decrypt recovers the original plaintext exactly.
    #[wasm_bindgen_test(async)]
    fn wasm_round_trip_with_random_nonce() -> ThenReady {
        ThenReady::new(|| {
            let key = Key::random().expect("Key::random() failed");
            let plaintext = Vec::from("Zim wiki notes, encrypted end-to-end, on wasm32.".as_bytes());

            let op = CryptoOp::new("chacha20poly1305").unwrap();
            let envelope = encrypt(&key, plaintext.clone(), op).expect("wasm crypto::encrypt() failed");
            let decrypted = decrypt(&key, envelope).expect("wasm crypto::decrypt() failed");
            assert_eq!(decrypted, plaintext);
        })
    }

    /// Tamper check (mirrors `core/wasm-crypto-poc/test/run_test.js`'s tamper
    /// check): flipping a byte inside the AAD-covered header, or the last
    /// ciphertext/tag byte, must make `crypto::decrypt()` fail authentication
    /// -- proving the AAD binding is genuinely enforced by the real wasm
    /// bridge, not just "decryption happens to work on well-formed input."
    #[wasm_bindgen_test(async)]
    fn wasm_rejects_tampered_envelope() -> ThenReady {
        ThenReady::new(|| {
            let (_, key_hex, _, envelope_hex) = GOLDEN_VECTORS[1]; // short_ascii: non-empty ciphertext
            let key = Key::new(from_hex(&String::from(key_hex)).unwrap());
            let envelope = from_hex(&String::from(envelope_hex)).unwrap();

            // sanity: the untampered envelope must still decrypt fine.
            decrypt(&key, envelope.clone()).expect("untampered envelope failed to decrypt");

            let mut tampered_header = envelope.clone();
            tampered_header[0] ^= 0xff; // flip a byte inside the AAD-covered header
            match decrypt(&key, tampered_header) {
                Err(CryptoError::Authentication(..)) => {}
                other => panic!("tampered header was not rejected as an authentication failure: {:?}", other),
            }

            let mut tampered_ciphertext = envelope.clone();
            let last = tampered_ciphertext.len() - 1;
            tampered_ciphertext[last] ^= 0xff; // flip the last ciphertext/tag byte
            match decrypt(&key, tampered_ciphertext) {
                Err(CryptoError::Authentication(..)) => {}
                other => panic!("tampered ciphertext was not rejected as an authentication failure: {:?}", other),
            }
        })
    }
}

