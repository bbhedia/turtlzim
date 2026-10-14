// Zim Notebook for Windows and Linux: the web app (../web/dist) in the system's WebView (WebView2, WebKitGTK), and nothing of its
// own but what a WebView lacks: the page's script (shell.js) and a command that saves a file where the person says.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use percent_encoding::percent_decode_str;
use std::path::Path;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// The script that runs in the page before the app, with the versions filled in.
fn shell_script() -> String {
    include_str!("../shell.js").replace("__ZIM_VERSION__", &format!("{} · web build {}", env!("CARGO_PKG_VERSION"), env!("ZIM_WEB_BUILD")))
}

/// Ask where to save the bytes that come with the request (the file's name is in `x-file-name`, percent-encoded) and write them there.
/// Whether the person chose a place: `false` when they cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the file's bytes did not come with the request".into());
    };
    let named = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    // (only the name: whatever folders it came with are not the program's to create)
    let name = Path::new(&named).file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty()).unwrap_or("file").to_string();
    let Some(chosen) = app.dialog().file().set_file_name(&name).blocking_save_file() else {
        return Ok(false);
    };
    let path = chosen.into_path().map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| format!("could not write {}: {error}", path.display()))?;
    Ok(true)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Zim Notebook")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 400.0)
                // (https, as on Android: a page that needs a secure context has one on every system)
                .use_https_scheme(true)
                .initialization_script(shell_script())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the program could not start");
}
