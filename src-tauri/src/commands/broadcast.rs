#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::{collections::HashMap, sync::Mutex};

use base64::Engine;
use rhema_broadcast::ndi::{NdiRuntime, NdiSessionInfo, NdiStartRequest};
use serde::{Deserialize, Serialize};
use tauri::utils::config::{BackgroundThrottlingPolicy, Color};
use tauri::State;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

fn emit_preview_closed(app: &tauri::AppHandle, output_id: &str) {
    let _ = app.emit(
        "broadcast:preview-closed",
        serde_json::json!({ "outputId": output_id }),
    );
}

/// Map `output_id` ("main" | "alt") to Tauri window label.
fn window_label(output_id: &str) -> &'static str {
    match output_id {
        "alt" => "broadcast-alt",
        _ => "broadcast",
    }
}

const BROADCAST_OUTPUT_URL: &str = "broadcast-output.html";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastSnapshot {
    pub version: u64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Default)]
pub struct BroadcastSnapshotStore {
    next_version: u64,
    outputs: HashMap<String, BroadcastSnapshot>,
}

impl BroadcastSnapshotStore {
    fn set(&mut self, output_id: String, payload: serde_json::Value) -> BroadcastSnapshot {
        self.next_version = self.next_version.saturating_add(1);
        let snapshot = BroadcastSnapshot {
            version: self.next_version,
            payload,
        };
        self.outputs.insert(output_id, snapshot.clone());
        snapshot
    }

    fn get(&self, output_id: &str) -> Option<BroadcastSnapshot> {
        self.outputs.get(output_id).cloned()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewCloseAction {
    Destroy,
    Hide,
}

fn preview_close_action(ndi_active: bool, force_destroy: bool) -> PreviewCloseAction {
    if force_destroy || !ndi_active {
        PreviewCloseAction::Destroy
    } else {
        PreviewCloseAction::Hide
    }
}

#[derive(Serialize)]
pub struct MonitorInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NdiFrameRequest {
    pub output_id: String,
    pub width: u32,
    pub height: u32,
    pub rgba_base64: String,
}

#[tauri::command]
pub fn list_monitors(app: tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(monitors
        .iter()
        .map(|m| {
            let size = m.size();
            MonitorInfo {
                name: m.name().cloned().unwrap_or_else(|| "Unknown".to_string()),
                width: size.width,
                height: size.height,
            }
        })
        .collect())
}

/// Ensure the broadcast window for a given output exists (creates hidden if not).
#[tauri::command]
pub async fn ensure_broadcast_window(
    app: tauri::AppHandle,
    output_id: String,
) -> Result<(), String> {
    let label = window_label(&output_id);
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(BROADCAST_OUTPUT_URL.into()))
        .title(if output_id == "alt" {
            "Rhema NDI Alt"
        } else {
            "Rhema NDI"
        })
        .inner_size(1920.0, 1080.0)
        .background_color(Color(0, 0, 0, 255))
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .on_page_load(|window, payload| {
            log::info!(
                "Broadcast page {:?}: label={}, url={}",
                payload.event(),
                window.label(),
                payload.url()
            );
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_broadcast_window(
    app: tauri::AppHandle,
    output_id: String,
    monitor_index: usize,
) -> Result<(), String> {
    let label = window_label(&output_id);
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .get(monitor_index)
        .ok_or_else(|| format!("Monitor index {monitor_index} out of range"))?;

    let pos = monitor.position();
    let size = monitor.size();

    // If window already exists (e.g. hidden for NDI), reuse it
    if let Some(window) = app.get_webview_window(label) {
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: pos.x,
                y: pos.y,
            }))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: size.width,
                height: size.height,
            }))
            .map_err(|e| e.to_string())?;
        window.set_decorations(true).map_err(|e| e.to_string())?;
        window.set_skip_taskbar(false).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let title = if output_id == "alt" {
        "Projector - Alt"
    } else {
        "Projector - Program"
    };

    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(BROADCAST_OUTPUT_URL.into()))
        .title(title)
        .position(f64::from(pos.x), f64::from(pos.y))
        .inner_size(f64::from(size.width), f64::from(size.height))
        .background_color(Color(0, 0, 0, 255))
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .decorations(true)
        .always_on_top(false)
        .skip_taskbar(false)
        .focused(true)
        .on_page_load(|window, payload| {
            log::info!(
                "Broadcast page {:?}: label={}, url={}",
                payload.event(),
                window.label(),
                payload.url()
            );
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Whether the broadcast webview for this output is currently visible (projector preview open).
#[tauri::command]
pub fn is_broadcast_window_visible(
    app: tauri::AppHandle,
    output_id: String,
) -> Result<bool, String> {
    let label = window_label(&output_id);
    let Some(window) = app.get_webview_window(label) else {
        return Ok(false);
    };
    window.is_visible().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_broadcast_window(
    app: tauri::AppHandle,
    output_id: String,
    runtime: State<'_, Mutex<NdiRuntime>>,
    force_destroy: Option<bool>,
) -> Result<(), String> {
    let label = window_label(&output_id);
    let Some(window) = app.get_webview_window(label) else {
        emit_preview_closed(&app, &output_id);
        return Ok(());
    };

    let ndi_active = runtime
        .lock()
        .map_err(|e| e.to_string())?
        .is_active(&output_id);

    if preview_close_action(ndi_active, force_destroy.unwrap_or(false))
        == PreviewCloseAction::Destroy
    {
        window.close().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
        emit_preview_closed(&app, &output_id);
    }
    Ok(())
}

#[tauri::command]
pub fn set_broadcast_snapshot(
    app: tauri::AppHandle,
    output_id: String,
    payload: serde_json::Value,
    snapshots: State<'_, Mutex<BroadcastSnapshotStore>>,
) -> Result<u64, String> {
    let snapshot = snapshots
        .lock()
        .map_err(|error| error.to_string())?
        .set(output_id.clone(), payload);

    if let Some(window) = app.get_webview_window(window_label(&output_id)) {
        window
            .emit("broadcast:snapshot-update", &snapshot)
            .map_err(|error| error.to_string())?;
    }

    Ok(snapshot.version)
}

#[tauri::command]
pub fn get_broadcast_snapshot(
    output_id: String,
    snapshots: State<'_, Mutex<BroadcastSnapshotStore>>,
) -> Result<Option<BroadcastSnapshot>, String> {
    snapshots
        .lock()
        .map_err(|error| error.to_string())
        .map(|store| store.get(&output_id))
}

#[tauri::command]
pub fn start_ndi(
    output_id: String,
    runtime: State<'_, Mutex<NdiRuntime>>,
    request: NdiStartRequest,
) -> Result<NdiSessionInfo, String> {
    let mut runtime = runtime.lock().map_err(|e| e.to_string())?;
    runtime.start(output_id, request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_ndi(output_id: String, runtime: State<'_, Mutex<NdiRuntime>>) -> Result<(), String> {
    let mut runtime = runtime.lock().map_err(|e| e.to_string())?;
    runtime.stop(&output_id);
    Ok(())
}

#[derive(Serialize)]
pub struct NdiStatusResponse {
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[tauri::command]
pub fn get_ndi_status(
    output_id: String,
    runtime: State<'_, Mutex<NdiRuntime>>,
) -> Result<Option<NdiStatusResponse>, String> {
    let runtime = runtime.lock().map_err(|e| e.to_string())?;
    match runtime.current_info(&output_id) {
        Some(info) => Ok(Some(NdiStatusResponse {
            active: true,
            width: info.width,
            height: info.height,
            fps: info.fps,
        })),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn push_ndi_frame(
    runtime: State<'_, Mutex<NdiRuntime>>,
    request: NdiFrameRequest,
) -> Result<(), String> {
    let rgba_data = base64::engine::general_purpose::STANDARD
        .decode(&request.rgba_base64)
        .map_err(|e| format!("base64 decode error: {e}"))?;
    let mut runtime = runtime.lock().map_err(|e| e.to_string())?;
    runtime
        .send_frame_rgba(
            &request.output_id,
            request.width,
            request.height,
            &rgba_data,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{preview_close_action, window_label, BroadcastSnapshotStore, PreviewCloseAction};
    use serde_json::json;

    #[test]
    fn preview_close_action_should_destroy_when_ndi_is_inactive() {
        assert_eq!(
            preview_close_action(false, false),
            PreviewCloseAction::Destroy
        );
    }

    #[test]
    fn preview_close_action_should_hide_when_ndi_is_active() {
        assert_eq!(preview_close_action(true, false), PreviewCloseAction::Hide);
    }

    #[test]
    fn preview_close_action_should_destroy_when_forced_with_ndi_active() {
        assert_eq!(
            preview_close_action(true, true),
            PreviewCloseAction::Destroy
        );
    }

    #[test]
    fn window_label_should_map_main_output() {
        assert_eq!(window_label("main"), "broadcast");
    }

    #[test]
    fn window_label_should_map_alternate_output() {
        assert_eq!(window_label("alt"), "broadcast-alt");
    }

    #[test]
    fn snapshot_store_should_return_latest_payload() {
        let mut store = BroadcastSnapshotStore::default();
        store.set("main".to_string(), json!({ "verse": "Genesis 1:1" }));
        store.set("main".to_string(), json!({ "verse": "Genesis 1:2" }));

        assert_eq!(
            store.get("main").map(|snapshot| snapshot.payload),
            Some(json!({ "verse": "Genesis 1:2" }))
        );
    }

    #[test]
    fn snapshot_store_should_increment_versions() {
        let mut store = BroadcastSnapshotStore::default();
        let first = store.set("main".to_string(), json!({}));
        let second = store.set("main".to_string(), json!({}));

        assert!(second.version > first.version);
    }

    #[test]
    fn snapshot_store_should_keep_outputs_independent() {
        let mut store = BroadcastSnapshotStore::default();
        store.set("main".to_string(), json!({ "verse": "John 3:16" }));

        assert!(store.get("alt").is_none());
    }
}
