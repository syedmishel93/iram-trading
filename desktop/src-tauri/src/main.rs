// IRAM Terminal — the desktop shell.
//
// WHY A NATIVE SHELL AT ALL, WHEN THE BUILD IS ONE SELF-CONTAINED index.html
//
// Not for the window decoration. Three concrete capabilities a browser tab
// cannot have, in order of how much they matter:
//
// 1. THE VENUE'S OWN RATE-LIMIT COUNTER BECOMES READABLE.
//    Binance sends `x-mbx-used-weight-1m` on every response, and a browser
//    cannot read it: the header is on the wire, but without an
//    `Access-Control-Expose-Headers` allowing it the fetch spec hides it from
//    page script. This was measured, and it is why the web build runs on a
//    local ESTIMATE of its own spend at a third of the published ceiling.
//    Requests issued from Rust are not subject to CORS at all, so here the
//    governor can read what the exchange actually thinks you have spent —
//    which is the difference between guessing you are safe and knowing.
//
// 2. NO TAB TO CLOSE, AND NO BROWSER TO UPDATE UNDER YOU. An alert daemon
//    running in a tab dies when somebody tidies their windows.
//
// 3. THE WINDOW REMEMBERS ITSELF. A terminal that opens 800x600 in the corner
//    every morning is a terminal you rearrange every morning.
//
// WHAT THIS PROCESS DELIBERATELY DOES NOT DO
// It holds no credentials, signs nothing, and opens no port. The capability
// allow-list in `capabilities/default.json` is the whole surface, and the HTTP
// scope there names market-data hosts and localhost only. There is no shell
// command permission, no arbitrary filesystem permission, and nothing that
// could place an order — the same guarantee the web build makes, enforced the
// same structural way: the capability does not exist in the process.

// A NOTE ON `visible: true` IN tauri.conf.json
// The usual pattern is to open hidden and reveal on first paint, so no white
// flash is ever seen. That requires the PAGE to call show() — and this page is
// the same bundle the browser build serves, which knows nothing about Tauri. A
// window that nothing ever shows is not a subtle bug, it is an application that
// does not open, which is exactly what the first build of this shell did.
// `backgroundColor` handles the flash instead, and costs no coupling.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        // Reads and writes the window's size and position. Without it the
        // window forgets its place every launch.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Rust-side HTTP. This is the plugin that lifts CORS — see note 1.
        .plugin(tauri_plugin_http::init())
        // A second launch focuses the running window instead of starting a
        // rival copy. Two terminals against one IndexedDB origin would have
        // them fighting over the same archive and the same alert book.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("failed to start the IRAM terminal window");
}
