mod commands;
mod conversion;
mod dto;
mod errors;
mod events;

use commands::convert_batch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![convert_batch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
