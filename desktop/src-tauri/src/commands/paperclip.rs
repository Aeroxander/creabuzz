use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::managed_agents::paperclip_manager::PaperclipStatus;

fn shutdown_started(state: &State<'_, AppState>) -> bool {
    state.shutdown_started.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn paperclip_status(state: State<'_, AppState>) -> Result<PaperclipStatus, String> {
    let http = state.http_client.clone();
    let mut manager = state.paperclip_manager.lock().await;
    Ok(manager.status(&http).await)
}

#[tauri::command]
pub async fn start_paperclip(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PaperclipStatus, String> {
    if shutdown_started(&state) {
        return Err("Buzz is shutting down".to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Buzz app data directory unavailable: {error}"))?;
    let http = state.http_client.clone();
    let stop_requested = &state.paperclip_stop_requested;
    let mut manager = state.paperclip_manager.lock().await;
    manager.start(&app_data_dir, &http, stop_requested).await
}

#[tauri::command]
pub async fn stop_paperclip(state: State<'_, AppState>) -> Result<PaperclipStatus, String> {
    use std::sync::atomic::Ordering;

    state.paperclip_stop_requested.store(true, Ordering::SeqCst);
    let mut manager = state.paperclip_manager.lock().await;
    let status = manager.stop().await;
    state
        .paperclip_stop_requested
        .store(false, Ordering::SeqCst);
    status
}
