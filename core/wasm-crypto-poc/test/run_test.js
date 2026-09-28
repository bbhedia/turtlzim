'use strict';

// Golden-vector parity test for the WASM crypto envelope proof-of-concept
// (see docs/wasm-port-plan.md, step 2). Loads real, native-generated
// (key, plaintext, envelope) triples (produced by
// core/turtl-core-rs's `crypto::tests::generate_wasm_golden_vectors` test --
// see that test for how to regenerate `golden_vectors.json`) and the
// wasm-pack `--target nodejs` build of this crate, then checks, for every
// vector:
//
//   1. wasm_encrypt(key, nonce_extracted_from_native_envelope, plaintext)
//      produces the EXACT SAME envelope bytes as the native
//      turtl_core::crypto::encrypt() call did (byte-for-byte, not just
//      "same length" or "decrypts ok").
//   2. wasm_decrypt(key, native_envelope) recovers the exact original
//      plaintext bytes.
//
// Run with: node test/run_test.js  (after `wasm-pack build --target nodejs`
// has produced ../pkg).

const fs = require('fs');
const path = require('path');

function hexToBuf(hex) {
    return Buffer.from(hex, 'hex');
}

function bufEq(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return Buffer.compare(bufA, bufB) === 0;
}

// Parses a turtl_core crypto envelope -- mirrors
// core/turtl-core-rs/src/crypto/mod.rs's `deserialize()` and this crate's
// own Rust-side `parse_envelope()` -- used here ONLY to pull the nonce
// (which native encrypt() picked at random) and the header bytes back out
// of a real native envelope, so we can feed the *same* nonce into
// wasm_encrypt() for a fair byte-for-byte comparison.
//
//   |-2 bytes-| |-1 byte----| |-N bytes-----------| |-1 byte-----| |-N bytes-| |-N bytes--|
//   | version | |desc length| |payload description| |nonce length| |  nonce  | |ciphertext|
function parseEnvelope(buf) {
    if (buf.length <= 2) {
        throw new Error('envelope too short (version)');
    }
    let idx = 2;
    if (buf.length <= idx) {
        throw new Error('envelope too short (desc length)');
    }
    const descLen = buf[idx];
    idx += 1;
    if (buf.length <= idx + descLen) {
        throw new Error('envelope too short (desc)');
    }
    idx += descLen;
    if (buf.length <= idx) {
        throw new Error('envelope too short (nonce length)');
    }
    const nonceLen = buf[idx];
    idx += 1;
    const nonceEnd = idx + nonceLen;
    if (nonceEnd >= buf.length) {
        throw new Error('malformed envelope (nonce/ciphertext)');
    }
    const nonce = buf.subarray(idx, nonceEnd);
    const ciphertext = buf.subarray(nonceEnd);
    const header = buf.subarray(0, nonceEnd);
    return { nonce, ciphertext, header };
}

async function main() {
    const pkgPath = path.join(__dirname, '..', 'pkg', 'wasm_crypto_poc.js');
    if (!fs.existsSync(pkgPath)) {
        console.error(`Missing ${pkgPath} -- run "wasm-pack build --target nodejs" first.`);
        process.exitCode = 1;
        return;
    }
    const wasm = require(pkgPath);

    const vectorsPath = path.join(__dirname, 'golden_vectors.json');
    if (!fs.existsSync(vectorsPath)) {
        console.error(`Missing ${vectorsPath} -- run the native golden-vector generator first:\n` +
            '  cd core/turtl-core-rs && cargo test --features sqlite-static crypto::tests::generate_wasm_golden_vectors');
        process.exitCode = 1;
        return;
    }
    const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

    let passCount = 0;
    let failCount = 0;

    console.log(`Running ${vectors.length} golden vectors against the wasm-pack (nodejs target) build...\n`);

    for (const v of vectors) {
        const key = hexToBuf(v.key_hex);
        const plaintext = hexToBuf(v.plaintext_hex);
        const nativeEnvelope = hexToBuf(v.envelope_hex);

        let encryptOk = false;
        let decryptOk = false;
        const notes = [];

        try {
            const { nonce } = parseEnvelope(nativeEnvelope);
            const wasmEnvelope = Buffer.from(await wasm.wasm_encrypt(key, nonce, plaintext));
            encryptOk = bufEq(wasmEnvelope, nativeEnvelope);
            if (!encryptOk) {
                notes.push(`encrypt: byte mismatch (native ${nativeEnvelope.length}B, wasm ${wasmEnvelope.length}B)`);
                notes.push(`  native: ${nativeEnvelope.toString('hex')}`);
                notes.push(`  wasm:   ${wasmEnvelope.toString('hex')}`);
            }
        } catch (e) {
            notes.push(`encrypt: threw ${e}`);
        }

        try {
            const wasmPlaintext = Buffer.from(await wasm.wasm_decrypt(key, nativeEnvelope));
            decryptOk = bufEq(wasmPlaintext, plaintext);
            if (!decryptOk) {
                notes.push(`decrypt: plaintext mismatch (expected ${plaintext.length}B, got ${wasmPlaintext.length}B)`);
            }
        } catch (e) {
            notes.push(`decrypt: threw ${e}`);
        }

        const ok = encryptOk && decryptOk;
        console.log(`[${ok ? 'PASS' : 'FAIL'}] ${v.name} (plaintext=${plaintext.length}B envelope=${nativeEnvelope.length}B) encrypt=${encryptOk ? 'ok' : 'FAIL'} decrypt=${decryptOk ? 'ok' : 'FAIL'}`);
        for (const n of notes) {
            console.log(`       ${n}`);
        }

        if (ok) {
            passCount += 1;
        } else {
            failCount += 1;
        }
    }

    console.log('');
    console.log('====================================================');
    console.log(`${passCount}/${vectors.length} vectors passed byte-exact parity (encrypt AND decrypt)`);
    console.log(failCount === 0
        ? 'OVERALL: PASS -- wasm build produces byte-identical envelopes to native turtl_core, both directions.'
        : `OVERALL: FAIL -- ${failCount} vector(s) did not match.`);
    console.log('====================================================');

    // Tamper check: confirms the AAD binding is genuinely load-bearing, not
    // just "decryption happens to work on well-formed input." A wasm_decrypt
    // that silently accepted a flipped header or ciphertext byte would mean
    // the AAD wasn't actually being checked -- a real integrity break.
    console.log('');
    console.log('Tamper check (flipped header byte / flipped ciphertext byte must both fail auth)...');
    let tamperOk = true;
    {
        const v = vectors.find((v) => hexToBuf(v.plaintext_hex).length > 0) || vectors[0];
        const key = hexToBuf(v.key_hex);
        const nativeEnvelope = hexToBuf(v.envelope_hex);

        const tamperedHeader = Buffer.from(nativeEnvelope);
        tamperedHeader[0] ^= 0xff; // flip a byte inside the AAD-covered header
        const tamperedCiphertext = Buffer.from(nativeEnvelope);
        tamperedCiphertext[tamperedCiphertext.length - 1] ^= 0xff; // flip the last ciphertext/tag byte

        for (const [label, buf] of [['header', tamperedHeader], ['ciphertext', tamperedCiphertext]]) {
            let threw = false;
            try {
                await wasm.wasm_decrypt(key, buf);
            } catch (e) {
                threw = true;
            }
            console.log(`  [${threw ? 'PASS' : 'FAIL'}] tampered ${label} byte correctly rejected: ${threw}`);
            if (!threw) tamperOk = false;
        }
    }
    console.log(tamperOk
        ? 'OVERALL TAMPER CHECK: PASS -- AAD/authentication is genuinely enforced.'
        : 'OVERALL TAMPER CHECK: FAIL -- tampered input was NOT rejected; AAD binding is not working.');
    console.log('====================================================');

    process.exitCode = (failCount === 0 && tamperOk) ? 0 : 1;
}

main().catch((e) => {
    console.error('FATAL:', e);
    process.exitCode = 1;
});
