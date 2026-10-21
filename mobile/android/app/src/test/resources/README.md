The same two certificates and identities as `desktop/src-tauri/testdata/` (see the README there; `web/test/trust-contract.test.ts` checks that they are the same files): self-signed, for `127.0.0.1`, `::1`
and `localhost`; `pin-a.pem` is a certificate, `pin-a.p12` the same with its key under the password `zim-test`. The key is **not a secret** (it is here so that a test can run a TLS server that shows one
certificate or the other). Nothing trusts them.
