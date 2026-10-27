mod commands;
mod conversion;
mod dto;
mod errors;
mod events;

use commands::convert_batch;
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
#[derive(Default)]
struct PendingActivation(AtomicBool);

#[cfg(desktop)]
fn activate_main_window(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Register first so repeated launches exit before creating another WebView.
    #[cfg(desktop)]
    let builder =
        builder
            .manage(PendingActivation::default())
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                // WebView2 can still be creating the main window when another launch arrives.
                let pending = app.state::<PendingActivation>();
                pending.0.store(true, Ordering::SeqCst);
                if activate_main_window(app) {
                    pending.0.store(false, Ordering::SeqCst);
                }
            }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            if app
                .state::<PendingActivation>()
                .0
                .swap(false, Ordering::SeqCst)
            {
                activate_main_window(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![convert_batch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
