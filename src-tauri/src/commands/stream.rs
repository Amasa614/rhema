#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::Engine;
use chrono::{DateTime, Utc};
use rhema_stream::{
    build_ffmpeg_args, join_rtmp_url, parse_dshow_devices, redact_stream_text,
    sanitize_ffmpeg_error_with_key, sanitize_ffmpeg_error_with_redactions, DshowDevices,
    StreamEncodeRequest, VideoEncoder,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use rhema_stream::sanitize_ffmpeg_error;

const OVERLAY_NAME: &str = "stream-overlay.png";

#[derive(Debug, Default)]
pub struct StreamRuntime {
    child: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
    overlay_path: Option<PathBuf>,
    last_error: Option<String>,
    stderr_log: Option<Arc<Mutex<String>>>,
    active: bool,
    local_recording_id: Option<String>,
    redactions: Vec<String>,
    watch_generation: u64,
}

impl StreamRuntime {
    fn invalidate_watchers(&mut self) {
        self.watch_generation = self.watch_generation.wrapping_add(1);
    }

    fn stop(&mut self) {
        self.invalidate_watchers();
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let deadline = Instant::now() + Duration::from_millis(2000);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            // Bounded wait: avoid hanging the command thread forever.
                            break;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        }
        self.stderr_log = None;
        self.overlay_path = None;
        self.redactions.clear();
        self.active = false;
    }
}

impl Drop for StreamRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub active: bool,
    pub ffmpeg_path: Option<String>,
    pub last_error: Option<String>,
    pub overlay_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStartPayload {
    pub server_url: String,
    pub stream_key: String,
    pub video_device: Option<String>,
    pub audio_device: Option<String>,
    pub include_overlay: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub video_bitrate_kbps: Option<u32>,
    #[serde(default = "default_record_local")]
    pub record_local: bool,
}

fn default_record_local() -> bool {
    true
}

fn is_phone_capture_device(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("iriun") || lower.contains("camo")
}

fn overlay_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(OVERLAY_NAME))
}

pub(crate) fn find_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(from_env) = std::env::var("FFMPEG_PATH") {
        let path = PathBuf::from(from_env);
        if path.is_file() {
            return Some(path);
        }
    }

    let names = ["ffmpeg.exe", "ffmpeg"];
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource) = app.path().resource_dir() {
        for name in names {
            candidates.push(resource.join(name));
            candidates.push(resource.join("ffmpeg").join(name));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in names {
                candidates.push(dir.join(name));
            }
        }
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for name in names {
        candidates.push(repo.join(name));
        candidates.push(repo.join("bin").join(name));
    }

    candidates.into_iter().find(|path| path.is_file()).or_else(ffmpeg_on_path)
}

fn ffmpeg_on_path() -> Option<PathBuf> {
    let program = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut command = Command::new(if cfg!(windows) { "where" } else { "which" });
    command.arg(program);
    hide_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if first.is_empty() {
        return None;
    }
    Some(PathBuf::from(first))
}

pub(crate) fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command;
}

pub(crate) fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<std::process::Output, String> {
    let mut command = Command::new(ffmpeg);
    command.args(args).stdin(Stdio::null());
    hide_window(&mut command);
    command.output().map_err(|error| error.to_string())
}

fn attach_stderr_drain(child: &mut Child, redactions: Vec<String>) -> Arc<Mutex<String>> {
    let log = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let log_clone = Arc::clone(&log);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let redacted = redact_stream_text(&line, &redactions);
                if let Ok(mut buffer) = log_clone.lock() {
                    buffer.push_str(&redacted);
                    buffer.push('\n');
                    if buffer.len() > 4000 {
                        let drain = buffer.len().saturating_sub(2000);
                        buffer.drain(..drain);
                    }
                }
            }
        });
    }
    log
}

fn spawn_ffmpeg(ffmpeg: &Path, args: &[String], pipe_stdin: bool) -> Result<Child, String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(args)
        .stdin(if pipe_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    command.spawn().map_err(|error| error.to_string())
}

const KICKSTART_JPEG: &[u8] = include_bytes!("kickstart.jpg");

fn prime_ffmpeg_stdin(child: &mut Child) -> Result<std::process::ChildStdin, String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "FFmpeg stdin is not available".to_string())?;
    stdin
        .write_all(KICKSTART_JPEG)
        .map_err(|error| format!("Could not send the first stream frame: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Could not send the first stream frame: {error}"))?;
    Ok(stdin)
}

fn spawn_primed_ffmpeg(
    ffmpeg: &Path,
    request: &StreamEncodeRequest,
    stream_key: &str,
) -> Result<(Child, std::process::ChildStdin, Arc<Mutex<String>>), String> {
    let args = build_ffmpeg_args(request)?;
    let mut child = spawn_ffmpeg(ffmpeg, &args, true)?;
    let redactions = if stream_key.is_empty() {
        Vec::new()
    } else {
        vec![stream_key.to_string()]
    };
    let stderr_log = attach_stderr_drain(&mut child, redactions);
    let stdin = prime_ffmpeg_stdin(&mut child)?;
    Ok((child, stdin, stderr_log))
}

fn stderr_snapshot(log: &Arc<Mutex<String>>) -> String {
    thread::sleep(Duration::from_millis(150));
    log.lock().ok().map(|guard| guard.clone()).unwrap_or_default()
}

#[expect(dead_code, reason = "kept for local recording overlays")]
fn write_placeholder_overlay(path: &Path, width: u32, height: u32) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    // 1×1 transparent PNG; FFmpeg scales it to the program size.
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let mut file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(png).map_err(|error| error.to_string())?;
    let _ = (width, height);
    Ok(())
}

#[tauri::command]
pub fn stream_status(
    app: AppHandle,
    runtime: State<'_, Mutex<StreamRuntime>>,
) -> Result<StreamStatus, String> {
    let runtime = runtime.lock().map_err(|error| error.to_string())?;
    Ok(StreamStatus {
        active: runtime.active,
        ffmpeg_path: find_ffmpeg(&app).map(|path| path.display().to_string()),
        last_error: runtime.last_error.clone(),
        overlay_path: overlay_file(&app).ok().map(|path| path.display().to_string()),
    })
}

#[tauri::command]
pub fn stream_list_devices(app: AppHandle) -> Result<DshowDevices, String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        return Err("Live camera ingest is currently available on Windows only".into());
    }
    #[cfg(windows)]
    {
        let ffmpeg = find_ffmpeg(&app).ok_or_else(|| {
            "FFmpeg not found. Install FFmpeg and add it to PATH, or set FFMPEG_PATH.".to_string()
        })?;
        let output = run_ffmpeg(
            &ffmpeg,
            &[
                "-hide_banner".into(),
                "-f".into(),
                "dshow".into(),
                "-list_devices".into(),
                "true".into(),
                "-i".into(),
                "dummy".into(),
            ],
        )?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(parse_dshow_devices(&text))
    }
}

#[tauri::command]
pub fn stream_start(
    app: AppHandle,
    runtime: State<'_, Mutex<StreamRuntime>>,
    payload: StreamStartPayload,
) -> Result<StreamStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, runtime, payload);
        return Err("Live streaming is currently available on Windows only".into());
    }
    #[cfg(windows)]
    {
        let ffmpeg = find_ffmpeg(&app).ok_or_else(|| {
            "FFmpeg not found. Install FFmpeg and add it to PATH, or set FFMPEG_PATH.".to_string()
        })?;
        let width = payload.width.unwrap_or(1920);
        let height = payload.height.unwrap_or(1080);
        let fps = payload.fps.unwrap_or(30);
        let bitrate = payload.video_bitrate_kbps.unwrap_or(4500);
        if !(320..=3840).contains(&width) || !(180..=2160).contains(&height) {
            return Err("Stream size must be between 320x180 and 3840x2160".into());
        }
        if !(15..=60).contains(&fps) {
            return Err("FPS must be between 15 and 60".into());
        }
        if !(500..=20_000).contains(&bitrate) {
            return Err("Bitrate must be between 500 and 20000 kbps".into());
        }
        let going_live = !payload.server_url.trim().is_empty();
        if going_live && payload.stream_key.trim().is_empty() {
            return Err("Stream key is required to go live".into());
        }
        let destination = if going_live {
            Some(join_rtmp_url(&payload.server_url, &payload.stream_key)?)
        } else {
            None
        };
        if !going_live && !payload.record_local {
            return Err("Choose Go live or Record".into());
        }
        let overlay_path = None::<PathBuf>;
        let local_recording = if payload.record_local {
            Some(create_video_recording(&app, "mp4")?)
        } else {
            None
        };
        let record_path = local_recording
            .as_ref()
            .map(|recording| PathBuf::from(&recording.video_path));

        let request = StreamEncodeRequest {
            video_device: None,
            audio_device: payload.audio_device.filter(|name| {
                !name.is_empty() && name != "none" && !is_phone_capture_device(name)
            }),
            overlay_path: overlay_path.clone(),
            width,
            height,
            fps,
            video_bitrate_kbps: bitrate,
            encoder: VideoEncoder::Nvenc,
            destination,
            record_path,
            video_from_stdin: true,
        };

        {
            let mut runtime = runtime.lock().map_err(|error| error.to_string())?;
            if runtime.active {
                return Err("A live stream is already running".into());
            }
            runtime.stop();
        }

        let mut request = request;
        let stream_key = payload.stream_key.trim();
        let (mut child, mut stdin, mut stderr_log) =
            spawn_primed_ffmpeg(&ffmpeg, &request, stream_key)?;
        if let Some(_status) = wait_for_early_exit(&mut child, Duration::from_millis(2500)) {
            drop(stdin);
            let stderr = stderr_snapshot(&stderr_log);
            let diagnostic = sanitize_ffmpeg_error_with_key(&stderr, stream_key);
            if request.encoder == VideoEncoder::Nvenc {
                request.encoder = VideoEncoder::X264;
                let primed = spawn_primed_ffmpeg(&ffmpeg, &request, stream_key)?;
                child = primed.0;
                stdin = primed.1;
                stderr_log = primed.2;
                if let Some(_status) = wait_for_early_exit(&mut child, Duration::from_millis(2500)) {
                    drop(stdin);
                    let fallback_err = stderr_snapshot(&stderr_log);
                    return Err(sanitize_ffmpeg_error_with_key(&fallback_err, stream_key));
                }
            } else {
                return Err(diagnostic);
            }
        }

        if let Some(recording) = local_recording.as_ref() {
            let _ = app.emit("video_recording_started", recording);
        }
        let key = stream_key.to_string();
        let watch_generation = {
            let mut runtime = runtime.lock().map_err(|error| error.to_string())?;
            runtime.child = Some(child);
            runtime.stdin = Some(stdin);
            runtime.overlay_path = overlay_path;
            runtime.stderr_log = Some(stderr_log);
            runtime.last_error = None;
            runtime.active = true;
            runtime.local_recording_id = local_recording.map(|recording| recording.id);
            runtime.redactions.clear();
            if !key.is_empty() {
                runtime.redactions.push(key);
            }
            runtime.invalidate_watchers();
            runtime.watch_generation
        };

        watch_child(app.clone(), watch_generation);
        let _ = app.emit(
            "stream:status",
            serde_json::json!({ "active": true }),
        );
        stream_status(app, runtime)
    }
}

fn watch_child(app: AppHandle, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(750));
        let Some(runtime_state) = app.try_state::<Mutex<StreamRuntime>>() else {
            break;
        };
        let mut runtime = match runtime_state.lock() {
            Ok(guard) => guard,
            Err(_) => break,
        };
        if runtime.watch_generation != generation || !runtime.active {
            break;
        }
        let Some(child) = runtime.child.as_mut() else {
            break;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                let recording_id = runtime.local_recording_id.take();
                let stderr = runtime
                    .stderr_log
                    .as_ref()
                    .and_then(|log| log.lock().ok().map(|guard| guard.clone()))
                    .unwrap_or_default();
                runtime.child = None;
                runtime.stderr_log = None;
                runtime.active = false;
                let empty_output = stderr.to_ascii_lowercase().contains("received no packets");
                if !status.success() || empty_output {
                    runtime.last_error = Some(sanitize_ffmpeg_error_with_redactions(
                        &stderr,
                        &runtime.redactions,
                    ));
                }
                let last_error = runtime.last_error.clone();
                drop(runtime);
                if let Some(id) = recording_id {
                    let _ = finalize_video_recording(&app, &id);
                }
                let _ = app.emit(
                    "stream:status",
                    serde_json::json!({
                        "active": false,
                        "error": last_error,
                    }),
                );
                break;
            }
            Ok(None) => {}
            Err(error) => {
                runtime.active = false;
                runtime.last_error = Some(error.to_string());
                break;
            }
        }
    });
}

fn wait_for_early_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    return None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

#[tauri::command]
pub fn stream_stop(
    app: AppHandle,
    runtime: State<'_, Mutex<StreamRuntime>>,
) -> Result<StreamStatus, String> {
    let recording_id = {
        let mut runtime = runtime.lock().map_err(|error| error.to_string())?;
        let recording_id = runtime.local_recording_id.take();
        runtime.stop();
        runtime.last_error = None;
        recording_id
    };
    if let Some(id) = recording_id {
        let _ = finalize_video_recording(&app, &id);
    }
    let _ = app.emit("stream:status", serde_json::json!({ "active": false }));
    stream_status(app, runtime)
}

#[tauri::command]
pub fn push_stream_overlay(
    runtime: State<'_, Mutex<StreamRuntime>>,
    png_base64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            png_base64
                .trim_start_matches("data:image/png;base64,")
                .trim_start_matches("data:image/jpeg;base64,"),
        )
        .map_err(|error| format!("overlay decode: {error}"))?;
    let mut runtime = runtime.lock().map_err(|error| error.to_string())?;
    if !runtime.active {
        return Ok(());
    }
    if let Some(stdin) = runtime.stdin.as_mut() {
        stdin
            .write_all(&bytes)
            .map_err(|error| format!("stream frame: {error}"))?;
        let _ = stdin.flush();
    }
    Ok(())
}

pub fn stop_if_running(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<Mutex<StreamRuntime>>() {
        if let Ok(mut runtime) = runtime.lock() {
            let recording_id = runtime.local_recording_id.take();
            runtime.stop();
            if let Some(id) = recording_id {
                let _ = finalize_video_recording(app, &id);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRecording {
    pub id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub duration_seconds: f64,
    pub video_path: String,
}

struct ChunkArchive {
    writer: Option<BufWriter<File>>,
    recording_id: Option<String>,
}

fn chunk_archive() -> &'static Mutex<ChunkArchive> {
    static ARCHIVE: OnceLock<Mutex<ChunkArchive>> = OnceLock::new();
    ARCHIVE.get_or_init(|| {
        Mutex::new(ChunkArchive {
            writer: None,
            recording_id: None,
        })
    })
}

pub(crate) fn videos_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("videos");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn video_dir(app: &AppHandle, recording_id: &str) -> Result<PathBuf, String> {
    if recording_id.is_empty()
        || !recording_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid recording id".into());
    }
    Ok(videos_root(app)?.join(recording_id))
}

pub(crate) fn create_video_recording(app: &AppHandle, extension: &str) -> Result<VideoRecording, String> {
    let ext = if extension.eq_ignore_ascii_case("mp4") {
        "mp4"
    } else {
        "webm"
    };
    let created_at = Utc::now();
    let id = format!(
        "{}-{}",
        created_at.format("%Y%m%d-%H%M%S"),
        created_at.timestamp_subsec_millis()
    );
    let directory = videos_root(app)?.join(&id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let video_path = directory.join(format!("program.{ext}"));
    let recording = VideoRecording {
        id,
        title: created_at.format("%d %b %Y %H:%M").to_string(),
        created_at,
        duration_seconds: 0.0,
        video_path: video_path.to_string_lossy().into_owned(),
    };
    let json = serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?;
    fs::write(directory.join("recording.json"), json).map_err(|error| error.to_string())?;
    Ok(recording)
}

pub(crate) fn write_video_recording(directory: &Path, recording: &VideoRecording) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(recording).map_err(|error| error.to_string())?;
    fs::write(directory.join("recording.json"), json).map_err(|error| error.to_string())
}

pub(crate) fn read_video_recording(directory: &Path) -> Result<VideoRecording, String> {
    let json = fs::read_to_string(directory.join("recording.json")).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

fn finalize_video_recording(app: &AppHandle, recording_id: &str) -> Result<VideoRecording, String> {
    {
        let mut archive = chunk_archive().lock().map_err(|error| error.to_string())?;
        if archive.recording_id.as_deref() == Some(recording_id) {
            if let Some(mut writer) = archive.writer.take() {
                let _ = writer.flush();
            }
            archive.recording_id = None;
        }
    }
    let directory = video_dir(app, recording_id)?;
    let mut recording = read_video_recording(&directory)?;
    recording.duration_seconds = (Utc::now() - recording.created_at)
        .num_milliseconds()
        .max(0) as f64
        / 1000.0;
    let json = serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?;
    fs::write(directory.join("recording.json"), json).map_err(|error| error.to_string())?;
    let _ = app.emit("video_recording_saved", &recording);
    Ok(recording)
}

#[tauri::command]
pub fn video_recording_start(app: AppHandle, extension: String) -> Result<VideoRecording, String> {
    let recording = create_video_recording(&app, &extension)?;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&recording.video_path)
        .map_err(|error| error.to_string())?;
    let mut archive = chunk_archive().lock().map_err(|error| error.to_string())?;
    if let Some(mut writer) = archive.writer.take() {
        let _ = writer.flush();
    }
    archive.writer = Some(BufWriter::new(file));
    archive.recording_id = Some(recording.id.clone());
    let _ = app.emit("video_recording_started", &recording);
    Ok(recording)
}

#[tauri::command]
pub fn video_recording_append(chunk_base64: String) -> Result<(), String> {
    if chunk_base64.is_empty() {
        return Ok(());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk_base64.trim())
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Ok(());
    }
    let mut archive = chunk_archive().lock().map_err(|error| error.to_string())?;
    let writer = archive
        .writer
        .as_mut()
        .ok_or_else(|| "No video recording is active".to_string())?;
    writer.write_all(&bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn video_recording_stop(app: AppHandle) -> Result<VideoRecording, String> {
    let id = {
        let archive = chunk_archive().lock().map_err(|error| error.to_string())?;
        archive
            .recording_id
            .clone()
            .ok_or_else(|| "No video recording is active".to_string())?
    };
    finalize_video_recording(&app, &id)
}

#[tauri::command]
pub fn list_video_recordings(app: AppHandle) -> Result<Vec<VideoRecording>, String> {
    let root = videos_root(&app)?;
    let mut recordings = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() {
                read_video_recording(&path).ok()
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    recordings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(recordings)
}

#[tauri::command]
pub fn rename_video_recording(
    app: AppHandle,
    recording_id: String,
    title: String,
) -> Result<VideoRecording, String> {
    let directory = video_dir(&app, &recording_id)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("Recording title cannot be empty".to_string());
    }
    let mut recording = read_video_recording(&directory)?;
    recording.title = title.to_string();
    let json = serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?;
    fs::write(directory.join("recording.json"), json).map_err(|error| error.to_string())?;
    Ok(recording)
}

#[tauri::command]
pub fn delete_video_recording(app: AppHandle, recording_id: String) -> Result<(), String> {
    {
        let archive = chunk_archive().lock().map_err(|error| error.to_string())?;
        if archive.recording_id.as_deref() == Some(recording_id.as_str()) {
            return Err("Stop recording before deleting this video".to_string());
        }
    }
    let directory = video_dir(&app, &recording_id)?;
    fs::remove_dir_all(directory).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_video_recordings_folder(app: AppHandle) -> Result<(), String> {
    let root = videos_root(&app)?;
    #[cfg(windows)]
    {
        Command::new("explorer")
            .arg(root)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("Opening the recordings folder is only available on Windows".into())
    }
}
