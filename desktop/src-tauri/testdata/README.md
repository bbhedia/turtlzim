Certificates for the program's own tests (`src/tls.rs`, `src/account.rs`): two self-signed RSA-2048 certificates for `127.0.0.1`, `::1` and `localhost`, valid for a hundred years, made with

    openssl req -x509 -newkey rsa:2048 -nodes -keyout pin-a.key -out pin-a.pem -days 36500 -sha256 -subj "/CN=zim test certificate A" \
      -addext "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost" -addext "basicConstraints=critical,CA:FALSE" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment" -addext "extendedKeyUsage=serverAuth"
    openssl pkcs12 -export -inkey pin-a.key -in pin-a.pem -name zim-test -out pin-a.p12 -passout pass:zim-test \
      -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg SHA1

(and the same for B; the `.key` files were then deleted). `pin-a.pem` is the certificate; `pin-a.p12` is the certificate with its key, under the password `zim-test`, which is what a test's TLS server
shows. The key is **not a secret**: it is here so that a test can run a TLS server that shows one certificate or the other, which is what pinning is about, and it is in a file with a password so that no
private key is in the repository as text. (RSA, and 3DES for the file's own encryption, because the Windows backend of `native-tls` reads RSA identities and OpenSSL 3's default provider reads that
encryption.) Nothing trusts these certificates, and nothing in the program reads this folder.

`pin-a.pem`: SHA-256 `93:B9:5C:F3:A9:7D:EA:48:7F:20:8A:87:CA:FA:03:DB:E1:C3:50:85:3A:D7:A0:64:02:86:98:6D:5C:FF:F5:55` (`openssl x509 -in pin-a.pem -noout -fingerprint -sha256`).
`pin-b.pem`: SHA-256 `AA:5A:95:F1:7D:5A:44:04:6D:FD:8C:04:E4:F0:16:21:5C:57:E6:13:B6:D0:71:5E:EC:CA:65:ED:8E:DD:12:92`.
