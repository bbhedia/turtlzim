//! Shared test helper. Lives under `tests/common/` (not `tests/common.rs`) so
//! cargo does not treat it as its own test binary.

/// Assert that parsing then serializing `input` reproduces it byte-for-byte
/// (the spec §4 golden-file round-trip requirement).
#[allow(dead_code)]
pub fn assert_roundtrip(input: &str) {
    let page = zim_format::parse(input);
    let output = page.serialize();
    assert_eq!(
        output, input,
        "round-trip mismatch\n--- expected ---\n{input:?}\n--- got ---\n{output:?}"
    );
}
