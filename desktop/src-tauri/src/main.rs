// Zim Notebook for Windows and Linux: the web app (../web/dist) in the system's WebView (WebView2, WebKitGTK), and nothing of its
// own but what a WebView lacks: the page's script (shell.js) and a command that saves a file where the person says.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use percent_encoding::percent_decode_str;
use std::path::Path;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// Whether the page's errors are to be written to this program's standard error: only when it was started with `ZIM_DESKTOP_DEBUG` set (to
/// find out why a page does not start). Never by default: a message can name a page.
fn debugging() -> bool {
    std::env::var_os("ZIM_DESKTOP_DEBUG").is_some()
}

/// The script that runs in the page before the app, with the versions filled in.
fn shell_script() -> String {
    include_str!("../shell.js")
        .replace("__ZIM_VERSION__", &format!("{} · web build {}", env!("CARGO_PKG_VERSION"), env!("ZIM_WEB_BUILD")))
        .replace("__ZIM_DEBUG__", if debugging() { "true" } else { "false" })
}

/// What the page says about its errors, when asked to (`debugging`).
#[tauri::command]
fn debug_log(message: String) {
    if debugging() {
        eprintln!("[page] {message}");
    }
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

/// WebKitGTK is built with the web's storage and file system APIs **off** (the embedder is to turn them on): without them `navigator.storage` does
/// not exist, so there is no OPFS, and the encrypted notebooks (the vault keeps its database there, in a Worker) cannot be made. They are
/// switched on here, in the settings of the view, by the names that WebKitGTK gives its features (`webkit_settings_get_all_features`, 2.42 and
/// later, found at run time: an older WebKitGTK has no such list and is left as it is). Returns whether any was switched on.
#[cfg(target_os = "linux")]
fn linux_web_features(view: &webkit2gtk::WebView) -> bool {
    use std::ffi::{c_char, c_void, CStr};
    use webkit2gtk::glib::translate::ToGlibPtr;
    use webkit2gtk::WebViewExt;

    extern "C" {
        fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    }
    const WANTED: [&str; 5] = ["StorageAPI", "StorageAPIEstimate", "FileSystem", "FileSystemWritableStream", "AccessHandle"];
    // SAFETY: the functions are WebKitGTK's own (found by name in what this program has loaded) and are called as its documentation says: the
    // list is ours to free, a feature of it is borrowed from it, the settings belong to the view.
    unsafe {
        let find = |name: &CStr| dlsym(std::ptr::null_mut(), name.as_ptr());
        let (all, length, get, identifier, enable, unref) = (
            find(c"webkit_settings_get_all_features"),
            find(c"webkit_feature_list_get_length"),
            find(c"webkit_feature_list_get"),
            find(c"webkit_feature_get_identifier"),
            find(c"webkit_settings_set_feature_enabled"),
            find(c"webkit_feature_list_unref"),
        );
        if [all, length, get, identifier, enable, unref].iter().any(|f| f.is_null()) {
            return false;
        }
        let all: extern "C" fn() -> *mut c_void = std::mem::transmute(all);
        let length: extern "C" fn(*mut c_void) -> usize = std::mem::transmute(length);
        let get: extern "C" fn(*mut c_void, usize) -> *mut c_void = std::mem::transmute(get);
        let identifier: extern "C" fn(*mut c_void) -> *const c_char = std::mem::transmute(identifier);
        let enable: extern "C" fn(*mut c_void, *mut c_void, i32) = std::mem::transmute(enable);
        let unref: extern "C" fn(*mut c_void) = std::mem::transmute(unref);

        let Some(settings) = view.settings() else { return false };
        let settings: *mut c_void = ToGlibPtr::<*mut webkit2gtk::ffi::WebKitSettings>::to_glib_none(&settings).0 as *mut c_void;
        let features = all();
        let mut switched = 0;
        for index in 0..length(features) {
            let feature = get(features, index);
            let name = CStr::from_ptr(identifier(feature)).to_string_lossy();
            if WANTED.contains(&name.as_ref()) {
                enable(settings, feature, 1);
                switched += 1;
            }
        }
        unref(features);
        switched > 0
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file, debug_log])
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Zim Notebook")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 400.0)
                // (https, as on Android: a page that needs a secure context has one on every system)
                .use_https_scheme(true)
                .initialization_script(shell_script())
                .build()?;
            // (the page has started loading by now: it is loaded again with the features on, which costs a blink)
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| {
                use webkit2gtk::WebViewExt;
                let view = webview.inner();
                if linux_web_features(&view) {
                    view.reload();
                }
            })?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the program could not start");
}
