fn main() {
    // The web build that is inside this app, by the fingerprint that the web app's own worker lists (web/dist/sw.js): the About
    // dialog says it, so that two copies of the app can be told apart.
    println!("cargo:rerun-if-changed=../../web/dist/sw.js");
    let worker = std::fs::read_to_string("../../web/dist/sw.js").unwrap_or_default();
    let id = worker
        .split("/*MANIFEST*/")
        .nth(1)
        .and_then(|rest| rest.split("\"id\":\"").nth(1))
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("unknown");
    println!("cargo:rustc-env=ZIM_WEB_BUILD={id}");
    tauri_build::build()
}
