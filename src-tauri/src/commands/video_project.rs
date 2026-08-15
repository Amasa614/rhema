#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::postproduction::{analyze_wav, WaveformData};
use super::stream::{
    create_video_recording, find_ffmpeg, hide_window, read_video_recording, sanitize_ffmpeg_error,
    videos_root, write_video_recording, VideoRecording,
};

const PROJECT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub label: String,
    pub path: String,
    pub duration_seconds: f64,
    pub has_embedded_audio: bool,
    pub offline: bool,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform_peaks: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: String,
    pub track_id: String,
    pub asset_id: String,
    pub timeline_start: f64,
    pub source_in: f64,
    pub source_out: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub mute_embedded_audio: bool,
    #[serde(default = "default_volume")]
    pub volume: f64,
    #[serde(default)]
    pub locked: bool,
}

fn default_volume() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTrack {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEditorProject {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub assets: Vec<MediaAsset>,
    pub tracks: Vec<TimelineTrack>,
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorProjectSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub duration_seconds: f64,
    pub clip_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorExportSettings {
    pub mode: String,
    #[serde(default)]
    pub destination_path: Option<String>,
    #[serde(default)]
    pub audio_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorJobProgress {
    pub job_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub stage: String,
    pub percent: Option<f64>,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub result_path: Option<String>,
    #[serde(default)]
    pub result_recording_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeResult {
    pub path: String,
    pub kind: String,
    pub duration_seconds: f64,
    pub has_embedded_audio: bool,
    pub has_video: bool,
}

struct ActiveJob {
    cancel: Arc<AtomicBool>,
    child: Mutex<Option<Child>>,
}

fn jobs() -> &'static Mutex<HashMap<String, ActiveJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, ActiveJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("video-projects");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    validate_id(project_id)?;
    Ok(projects_root(app)?.join(project_id))
}

fn project_media_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let dir = project_dir(app, project_id)?.join("media");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid id".into());
    }
    Ok(())
}

fn new_id(prefix: &str) -> String {
    let now = Utc::now();
    format!(
        "{}-{}-{}",
        prefix,
        now.format("%Y%m%d-%H%M%S"),
        now.timestamp_subsec_millis()
    )
}

fn default_tracks() -> Vec<TimelineTrack> {
    vec![
        TimelineTrack {
            id: "V1".into(),
            kind: "video".into(),
            name: "V1".into(),
            muted: false,
            locked: false,
        },
        TimelineTrack {
            id: "A1".into(),
            kind: "audio".into(),
            name: "A1".into(),
            muted: false,
            locked: false,
        },
        TimelineTrack {
            id: "A2".into(),
            kind: "audio".into(),
            name: "A2".into(),
            muted: false,
            locked: false,
        },
    ]
}

fn empty_project(id: String, title: String) -> VideoEditorProject {
    let now = Utc::now().to_rfc3339();
    VideoEditorProject {
        version: PROJECT_VERSION,
        id,
        title,
        created_at: now.clone(),
        updated_at: now,
        assets: Vec::new(),
        tracks: default_tracks(),
        clips: Vec::new(),
    }
}

fn write_project(directory: &Path, project: &VideoEditorProject) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(project).map_err(|error| error.to_string())?;
    let temp = directory.join("project.json.tmp");
    let final_path = directory.join("project.json");
    fs::write(&temp, json).map_err(|error| error.to_string())?;
    fs::rename(&temp, final_path).map_err(|error| error.to_string())
}

fn read_project(directory: &Path) -> Result<VideoEditorProject, String> {
    let json = fs::read_to_string(directory.join("project.json")).map_err(|error| error.to_string())?;
    let mut project: VideoEditorProject =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if project.version != PROJECT_VERSION {
        return Err("Unsupported project version".into());
    }
    for asset in &mut project.assets {
        asset.offline = !Path::new(&asset.path).is_file();
    }
    Ok(project)
}

pub(crate) fn validate_project(project: &VideoEditorProject) -> Result<(), String> {
    if project.version != PROJECT_VERSION {
        return Err("Unsupported project version".into());
    }
    if project.id.trim().is_empty() {
        return Err("Project id is required".into());
    }
    let track_ids: std::collections::HashSet<_> =
        project.tracks.iter().map(|track| track.id.as_str()).collect();
    let asset_ids: std::collections::HashSet<_> =
        project.assets.iter().map(|asset| asset.id.as_str()).collect();
    for clip in &project.clips {
        if !track_ids.contains(clip.track_id.as_str()) {
            return Err(format!("Clip {} references missing track", clip.id));
        }
        if !asset_ids.contains(clip.asset_id.as_str()) {
            return Err(format!("Clip {} references missing asset", clip.id));
        }
        if !(clip.source_out > clip.source_in) {
            return Err(format!("Clip {} has an invalid source range", clip.id));
        }
        if !clip.timeline_start.is_finite() || clip.timeline_start < 0.0 {
            return Err(format!("Clip {} has an invalid timeline start", clip.id));
        }
    }
    Ok(())
}

fn clip_duration(clip: &TimelineClip) -> f64 {
    (clip.source_out - clip.source_in).max(0.0)
}

fn clip_end(clip: &TimelineClip) -> f64 {
    clip.timeline_start + clip_duration(clip)
}

fn project_duration(project: &VideoEditorProject) -> f64 {
    project
        .clips
        .iter()
        .map(clip_end)
        .fold(0.0_f64, f64::max)
}

fn ffmpeg_bin(app: &AppHandle) -> Result<PathBuf, String> {
    find_ffmpeg(app).ok_or_else(|| {
        "FFmpeg not found. Install it with winget install FFmpeg or set FFMPEG_PATH.".to_string()
    })
}

fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    let marker = "Duration: ";
    let start = stderr.find(marker)? + marker.len();
    let token = stderr.get(start..)?.split(',').next()?.trim();
    let mut parts = token.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub(crate) fn probe_media(ffmpeg: &Path, input: &Path) -> MediaProbeResult {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-i"])
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let output = command.output().ok();
    let stderr = output
        .map(|result| String::from_utf8_lossy(&result.stderr).into_owned())
        .unwrap_or_default();
    let duration = parse_ffmpeg_duration(&stderr).unwrap_or(0.0);
    let has_audio = stderr.contains("Audio:");
    let has_video = stderr.contains("Video:");
    let kind = if has_video {
        "video"
    } else if has_audio {
        "audio"
    } else {
        "video"
    };
    MediaProbeResult {
        path: input.display().to_string(),
        kind: kind.into(),
        duration_seconds: duration,
        has_embedded_audio: has_audio,
        has_video,
    }
}

fn emit_job(app: &AppHandle, progress: EditorJobProgress) {
    let _ = app.emit("video_editor_job", &progress);
}

fn register_job(job_id: &str, cancel: Arc<AtomicBool>) {
    if let Ok(mut map) = jobs().lock() {
        map.insert(
            job_id.to_string(),
            ActiveJob {
                cancel,
                child: Mutex::new(None),
            },
        );
    }
}

fn set_job_child(job_id: &str, child: Child) {
    if let Ok(map) = jobs().lock() {
        if let Some(job) = map.get(job_id) {
            if let Ok(mut slot) = job.child.lock() {
                *slot = Some(child);
            }
        }
    }
}

fn clear_job(job_id: &str) {
    if let Ok(mut map) = jobs().lock() {
        map.remove(job_id);
    }
}

fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::SeqCst)
}

fn run_ffmpeg_cancellable(
    ffmpeg: &Path,
    args: &[String],
    job_id: &str,
    cancel: &AtomicBool,
    expected_duration: Option<f64>,
    on_progress: &dyn Fn(Option<f64>),
) -> Result<(), String> {
    if is_cancelled(cancel) {
        return Err("Cancelled".into());
    }
    let mut command = Command::new(ffmpeg);
    command
        .args(args)
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stderr_log = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let log = Arc::clone(&stderr_log);
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut buffer) = log.lock() {
                    buffer.push_str(&line);
                    buffer.push('\n');
                    if buffer.len() > 6000 {
                        let drain = buffer.len().saturating_sub(3000);
                        buffer.drain(..drain);
                    }
                }
            }
        });
    }
    set_job_child(job_id, child);
    if let Some(stdout) = stdout {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if is_cancelled(cancel) {
                break;
            }
            if let Some(value) = line.strip_prefix("out_time_ms=") {
                if let Ok(ms) = value.parse::<f64>() {
                    let percent = expected_duration
                        .filter(|duration| *duration > 0.0)
                        .map(|duration| ((ms / 1000.0) / duration * 100.0).clamp(0.0, 99.0));
                    on_progress(percent);
                }
            }
        }
    }
    let status = {
        let map = jobs().lock().map_err(|error| error.to_string())?;
        let job = map.get(job_id).ok_or_else(|| "Job missing".to_string())?;
        let mut child_slot = job.child.lock().map_err(|error| error.to_string())?;
        let Some(mut child) = child_slot.take() else {
            return Err("FFmpeg process missing".into());
        };
        if is_cancelled(cancel) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cancelled".into());
        }
        child.wait().map_err(|error| error.to_string())?
    };
    if is_cancelled(cancel) {
        return Err("Cancelled".into());
    }
    if status.success() {
        on_progress(Some(100.0));
        return Ok(());
    }
    let stderr = stderr_log
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default();
    Err(sanitize_ffmpeg_error(&stderr))
}

fn asset_from_recording(recording: &VideoRecording, ffmpeg: &Path) -> MediaAsset {
    let path = PathBuf::from(&recording.video_path);
    let probe = if path.is_file() {
        probe_media(ffmpeg, &path)
    } else {
        MediaProbeResult {
            path: recording.video_path.clone(),
            kind: "video".into(),
            duration_seconds: recording.duration_seconds,
            has_embedded_audio: true,
            has_video: true,
        }
    };
    MediaAsset {
        id: format!("rec-{}", recording.id),
        kind: "video".into(),
        role: "program".into(),
        label: recording.title.clone(),
        path: recording.video_path.clone(),
        duration_seconds: if probe.duration_seconds > 0.1 {
            probe.duration_seconds
        } else {
            recording.duration_seconds
        },
        has_embedded_audio: probe.has_embedded_audio,
        offline: !path.is_file(),
        created_at: recording.created_at.to_rfc3339(),
        recording_id: Some(recording.id.clone()),
        waveform_peaks: None,
    }
}

fn copy_into_project_media(
    app: &AppHandle,
    project_id: &str,
    source: &Path,
    preferred_name: &str,
) -> Result<PathBuf, String> {
    let media = project_media_dir(app, project_id)?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    let stem = Path::new(preferred_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("media");
    let safe_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let file_name = format!("{}-{}.{}", safe_stem, Utc::now().timestamp_millis(), extension);
    let destination = media.join(file_name);
    fs::copy(source, &destination).map_err(|error| error.to_string())?;
    Ok(destination)
}

#[tauri::command]
pub fn list_editor_projects(app: AppHandle) -> Result<Vec<EditorProjectSummary>, String> {
    let root = projects_root(&app)?;
    let mut summaries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map(|value| value.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(project) = read_project(&entry.path()) else {
            continue;
        };
        summaries.push(EditorProjectSummary {
            id: project.id.clone(),
            title: project.title.clone(),
            updated_at: project.updated_at.clone(),
            duration_seconds: project_duration(&project),
            clip_count: project.clips.len(),
        });
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(summaries)
}

#[tauri::command]
pub fn create_editor_project(
    app: AppHandle,
    title: Option<String>,
) -> Result<VideoEditorProject, String> {
    let id = new_id("proj");
    let directory = project_dir(&app, &id)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let project = empty_project(
        id,
        title
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Utc::now().format("Edit %d %b %Y %H:%M").to_string()),
    );
    write_project(&directory, &project)?;
    Ok(project)
}

#[tauri::command]
pub fn create_editor_project_from_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<VideoEditorProject, String> {
    let ffmpeg = ffmpeg_bin(&app)?;
    let directory = videos_root(&app)?.join(&recording_id);
    let recording = read_video_recording(&directory)?;
    if !Path::new(&recording.video_path).is_file() {
        return Err("This video file is not ready yet. Stop recording first.".into());
    }
    let mut project = create_editor_project(app.clone(), Some(recording.title.clone()))?;
    let asset = asset_from_recording(&recording, &ffmpeg);
    let duration = asset.duration_seconds.max(0.1);
    let clip = TimelineClip {
        id: new_id("clip"),
        track_id: "V1".into(),
        asset_id: asset.id.clone(),
        timeline_start: 0.0,
        source_in: 0.0,
        source_out: duration,
        muted: false,
        mute_embedded_audio: false,
        volume: 1.0,
        locked: false,
    };
    project.assets.push(asset);
    project.clips.push(clip);
    project.updated_at = Utc::now().to_rfc3339();
    validate_project(&project)?;
    write_project(&project_dir(&app, &project.id)?, &project)?;
    Ok(project)
}

#[tauri::command]
pub fn load_editor_project(app: AppHandle, project_id: String) -> Result<VideoEditorProject, String> {
    read_project(&project_dir(&app, &project_id)?)
}

#[tauri::command]
pub fn save_editor_project(
    app: AppHandle,
    mut project: VideoEditorProject,
) -> Result<VideoEditorProject, String> {
    validate_project(&project)?;
    project.updated_at = Utc::now().to_rfc3339();
    let directory = project_dir(&app, &project.id)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    write_project(&directory, &project)?;
    Ok(project)
}

#[tauri::command]
pub fn delete_editor_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let directory = project_dir(&app, &project_id)?;
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_editor_media_assets(app: AppHandle) -> Result<Vec<MediaAsset>, String> {
    let ffmpeg = ffmpeg_bin(&app)?;
    let root = videos_root(&app)?;
    let mut assets = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map(|value| value.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(recording) = read_video_recording(&entry.path()) else {
            continue;
        };
        assets.push(asset_from_recording(&recording, &ffmpeg));
        let extracted = entry.path().join("extracted-audio.wav");
        if extracted.is_file() {
            let probe = probe_media(&ffmpeg, &extracted);
            assets.push(MediaAsset {
                id: format!("rec-{}-audio", recording.id),
                kind: "audio".into(),
                role: "extracted".into(),
                label: format!("{} (audio)", recording.title),
                path: extracted.display().to_string(),
                duration_seconds: probe.duration_seconds,
                has_embedded_audio: true,
                offline: false,
                created_at: recording.created_at.to_rfc3339(),
                recording_id: Some(recording.id.clone()),
                waveform_peaks: None,
            });
        }
    }
    assets.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(assets)
}

#[tauri::command]
pub fn probe_editor_media(app: AppHandle, path: String) -> Result<MediaProbeResult, String> {
    let ffmpeg = ffmpeg_bin(&app)?;
    let input = PathBuf::from(&path);
    if !input.is_file() {
        return Err("File not found".into());
    }
    Ok(probe_media(&ffmpeg, &input))
}

#[tauri::command]
pub fn import_editor_media(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<MediaAsset, String> {
    let ffmpeg = ffmpeg_bin(&app)?;
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("File not found".into());
    }
    let probe = probe_media(&ffmpeg, &source);
    let label = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported media")
        .to_string();
    let destination = copy_into_project_media(&app, &project_id, &source, &label)?;
    let kind = if probe.has_video {
        "video"
    } else if probe.has_embedded_audio {
        "audio"
    } else {
        return Err("Unsupported media file".into());
    };
    Ok(MediaAsset {
        id: new_id("asset"),
        kind: kind.into(),
        role: "imported".into(),
        label,
        path: destination.display().to_string(),
        duration_seconds: probe.duration_seconds.max(0.1),
        has_embedded_audio: probe.has_embedded_audio,
        offline: false,
        created_at: Utc::now().to_rfc3339(),
        recording_id: None,
        waveform_peaks: None,
    })
}

#[tauri::command]
pub fn analyze_editor_audio(
    path: String,
    points: Option<usize>,
) -> Result<WaveformData, String> {
    analyze_wav(
        Path::new(&path),
        points.unwrap_or(900).clamp(100, 4_000),
    )
}

#[tauri::command]
pub fn detach_editor_audio(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    source_path: String,
    label: String,
) -> Result<MediaAsset, String> {
    let ffmpeg = ffmpeg_bin(&app)?;
    let input = PathBuf::from(&source_path);
    if !input.is_file() {
        return Err("Source media is missing".into());
    }
    let probe = probe_media(&ffmpeg, &input);
    if !probe.has_embedded_audio {
        return Err("This clip has no audio to detach".into());
    }
    let media = project_media_dir(&app, &project_id)?;
    let audio_path = media.join(format!("{asset_id}-detached.wav"));
    let cancel = Arc::new(AtomicBool::new(false));
    let job_id = new_id("job");
    register_job(&job_id, Arc::clone(&cancel));
    let args = vec![
        "-y".into(),
        "-i".into(),
        input.display().to_string(),
        "-vn".into(),
        "-ac".into(),
        "2".into(),
        "-ar".into(),
        "48000".into(),
        audio_path.display().to_string(),
    ];
    let result = run_ffmpeg_cancellable(
        &ffmpeg,
        &args,
        &job_id,
        &cancel,
        Some(probe.duration_seconds),
        &|_| {},
    );
    clear_job(&job_id);
    result?;
    let waveform = analyze_wav(&audio_path, 900).ok();
    Ok(MediaAsset {
        id: new_id("asset"),
        kind: "audio".into(),
        role: "extracted".into(),
        label: format!("{label} (audio)"),
        path: audio_path.display().to_string(),
        duration_seconds: waveform
            .as_ref()
            .map(|data| data.duration_seconds)
            .unwrap_or(probe.duration_seconds)
            .max(0.1),
        has_embedded_audio: true,
        offline: false,
        created_at: Utc::now().to_rfc3339(),
        recording_id: None,
        waveform_peaks: waveform.map(|data| data.peaks),
    })
}

fn export_project_sync(
    app: &AppHandle,
    project: &VideoEditorProject,
    settings: &EditorExportSettings,
    job_id: &str,
    cancel: &AtomicBool,
) -> Result<(String, Option<String>), String> {
    let ffmpeg = ffmpeg_bin(app)?;
    let mode = settings.mode.as_str();
    let duration = project_duration(project).max(0.1);
    let work = project_dir(app, &project.id)?.join(format!("export-{job_id}"));
    if work.exists() {
        let _ = fs::remove_dir_all(&work);
    }
    fs::create_dir_all(&work).map_err(|error| error.to_string())?;

    let emit = |stage: &str, percent: Option<f64>, status: &str| {
        emit_job(
            app,
            EditorJobProgress {
                job_id: job_id.to_string(),
                project_id: Some(project.id.clone()),
                stage: stage.into(),
                percent,
                status: status.into(),
                error: None,
                result_path: None,
                result_recording_id: None,
            },
        );
    };

    emit("Preparing export", Some(1.0), "running");

    let asset_index: HashMap<&str, &MediaAsset> = project
        .assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();
    let track_index: HashMap<&str, &TimelineTrack> = project
        .tracks
        .iter()
        .map(|track| (track.id.as_str(), track))
        .collect();

    let result = (|| -> Result<(String, Option<String>), String> {
        if mode == "audioOnly" {
            let audio_clips: Vec<&TimelineClip> = project
                .clips
                .iter()
                .filter(|clip| {
                    let track = track_index.get(clip.track_id.as_str());
                    let is_audio_track = track.is_some_and(|value| value.kind == "audio");
                    let is_video_with_audio = track.is_some_and(|value| value.kind == "video")
                        && !clip.mute_embedded_audio
                        && !clip.muted;
                    (is_audio_track && !clip.muted)
                        || (is_video_with_audio
                            && asset_index
                                .get(clip.asset_id.as_str())
                                .is_some_and(|asset| asset.has_embedded_audio))
                })
                .collect();
            if audio_clips.is_empty() {
                return Err("No audible clips to export".into());
            }
            let mut mix_inputs = Vec::new();
            let mut filter = Vec::new();
            let mut labels = Vec::new();
            for (index, clip) in audio_clips.iter().enumerate() {
                let asset = asset_index
                    .get(clip.asset_id.as_str())
                    .ok_or_else(|| format!("Missing asset for clip {}", clip.id))?;
                if asset.offline || !Path::new(&asset.path).is_file() {
                    return Err(format!("Media offline: {}", asset.label));
                }
                mix_inputs.push(asset.path.clone());
                let delay_ms = (clip.timeline_start * 1000.0).round().max(0.0) as i64;
                let volume = if clip.muted { 0.0 } else { clip.volume.clamp(0.0, 2.0) };
                filter.push(format!(
                    "[{index}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,volume={volume},adelay={delay}|{delay}[a{index}]",
                    clip.source_in,
                    clip.source_out,
                    delay = delay_ms
                ));
                labels.push(format!("[a{index}]"));
            }
            let format = settings
                .audio_format
                .as_deref()
                .unwrap_or("wav");
            let output = if let Some(path) = &settings.destination_path {
                PathBuf::from(path)
            } else {
                let recording = create_video_recording(app, "mp4")?;
                let directory = PathBuf::from(&recording.video_path)
                    .parent()
                    .map(Path::to_path_buf)
                    .ok_or_else(|| "Invalid recording path".to_string())?;
                let _ = fs::remove_file(&recording.video_path);
                directory.join(format!("export-audio.{format}"))
            };
            let filter_complex = if labels.len() == 1 {
                format!("{};{}anull[aout]", filter.join(";"), labels[0])
            } else {
                format!(
                    "{};{}amix=inputs={}:duration=longest:dropout_transition=0[aout]",
                    filter.join(";"),
                    labels.join(""),
                    labels.len()
                )
            };
            let mut args = vec!["-y".into()];
            for path in &mix_inputs {
                args.push("-i".into());
                args.push(path.clone());
            }
            args.extend([
                "-filter_complex".into(),
                filter_complex,
                "-map".into(),
                "[aout]".into(),
                "-t".into(),
                format!("{duration:.3}"),
            ]);
            if format == "mp3" {
                args.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), "192k".into()]);
            } else {
                args.extend(["-c:a".into(), "pcm_s16le".into()]);
            }
            args.push(output.display().to_string());
            emit("Rendering audio", Some(5.0), "running");
            run_ffmpeg_cancellable(
                &ffmpeg,
                &args,
                job_id,
                cancel,
                Some(duration),
                &|percent| emit("Rendering audio", percent, "running"),
            )?;
            return Ok((output.display().to_string(), None));
        }

        // Video export: encode each V1 clip segment, then concat; mix audio separately.
        let mut sorted_video: Vec<&TimelineClip> = project
            .clips
            .iter()
            .filter(|clip| {
                track_index
                    .get(clip.track_id.as_str())
                    .is_some_and(|track| track.kind == "video")
            })
            .collect();
        sorted_video.sort_by(|left, right| {
            left.timeline_start
                .partial_cmp(&right.timeline_start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if sorted_video.is_empty() {
            return Err("Add at least one video clip before exporting".into());
        }

        let mut parts = Vec::new();
        let mut cursor = 0.0_f64;
        for (index, clip) in sorted_video.iter().enumerate() {
            if is_cancelled(cancel) {
                return Err("Cancelled".into());
            }
            let asset = asset_index
                .get(clip.asset_id.as_str())
                .ok_or_else(|| format!("Missing asset for clip {}", clip.id))?;
            if asset.offline || !Path::new(&asset.path).is_file() {
                return Err(format!("Media offline: {}", asset.label));
            }
            if clip.timeline_start > cursor + 0.05 {
                let gap = work.join(format!("gap-{index}.mp4"));
                let gap_duration = clip.timeline_start - cursor;
                let args = vec![
                    "-y".into(),
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    format!("color=c=black:s=1920x1080:d={gap_duration:.3}"),
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    format!("anullsrc=r=48000:cl=stereo:d={gap_duration:.3}"),
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "veryfast".into(),
                    "-crf".into(),
                    "23".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-shortest".into(),
                    gap.display().to_string(),
                ];
                emit("Rendering timeline", Some((index as f64 / (sorted_video.len() as f64 + 1.0)) * 40.0), "running");
                run_ffmpeg_cancellable(&ffmpeg, &args, job_id, cancel, Some(gap_duration), &|_| {})?;
                parts.push(gap);
            }
            let part = work.join(format!("part-{index}.mp4"));
            let clip_len = clip_duration(clip);
            let include_audio = mode == "videoAudio"
                && asset.has_embedded_audio
                && !clip.mute_embedded_audio
                && !clip.muted;
            let mut args = vec![
                "-y".into(),
                "-ss".into(),
                format!("{:.3}", clip.source_in),
                "-t".into(),
                format!("{clip_len:.3}"),
                "-i".into(),
                asset.path.clone(),
            ];
            if !include_audio {
                args.extend([
                    "-f".into(),
                    "lavfi".into(),
                    "-t".into(),
                    format!("{clip_len:.3}"),
                    "-i".into(),
                    "anullsrc=r=48000:cl=stereo".into(),
                ]);
            }
            args.extend([
                "-vf".into(),
                "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p".into(),
                "-map".into(),
                "0:v:0".into(),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                "23".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]);
            if include_audio {
                args.extend([
                    "-map".into(),
                    "0:a:0?".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "192k".into(),
                ]);
            } else {
                args.extend([
                    "-map".into(),
                    "1:a:0".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-shortest".into(),
                ]);
            }
            args.extend([
                "-movflags".into(),
                "+faststart".into(),
                part.display().to_string(),
            ]);
            emit(
                "Rendering clips",
                Some(((index as f64 + 1.0) / (sorted_video.len() as f64 + 1.0)) * 55.0),
                "running",
            );
            run_ffmpeg_cancellable(&ffmpeg, &args, job_id, cancel, Some(clip_len), &|_| {})?;
            parts.push(part);
            cursor = clip_end(clip);
        }
        if cursor < duration - 0.05 {
            let gap = work.join("gap-end.mp4");
            let gap_duration = duration - cursor;
            let args = vec![
                "-y".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("color=c=black:s=1920x1080:d={gap_duration:.3}"),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("anullsrc=r=48000:cl=stereo:d={gap_duration:.3}"),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                "23".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                "-c:a".into(),
                "aac".into(),
                "-shortest".into(),
                gap.display().to_string(),
            ];
            run_ffmpeg_cancellable(&ffmpeg, &args, job_id, cancel, Some(gap_duration), &|_| {})?;
            parts.push(gap);
        }

        let video_concat = work.join("video.mp4");
        let list_path = work.join("concat.txt");
        let list = parts
            .iter()
            .map(|path| format!("file '{}'", path.display().to_string().replace('\\', "/")))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&list_path, list).map_err(|error| error.to_string())?;
        emit("Joining clips", Some(70.0), "running");
        run_ffmpeg_cancellable(
            &ffmpeg,
            &[
                "-y".into(),
                "-f".into(),
                "concat".into(),
                "-safe".into(),
                "0".into(),
                "-i".into(),
                list_path.display().to_string(),
                "-c".into(),
                "copy".into(),
                video_concat.display().to_string(),
            ],
            job_id,
            cancel,
            Some(duration),
            &|percent| emit("Joining clips", percent.map(|value| 70.0 + value * 0.1), "running"),
        )?;

        let recording = create_video_recording(app, "mp4")?;
        let final_path = if let Some(path) = &settings.destination_path {
            PathBuf::from(path)
        } else {
            PathBuf::from(&recording.video_path)
        };

        if mode == "videoOnly" {
            emit("Finishing video", Some(85.0), "running");
            run_ffmpeg_cancellable(
                &ffmpeg,
                &[
                    "-y".into(),
                    "-i".into(),
                    video_concat.display().to_string(),
                    "-an".into(),
                    "-c:v".into(),
                    "copy".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    final_path.display().to_string(),
                ],
                job_id,
                cancel,
                Some(duration),
                &|percent| emit("Finishing video", percent.map(|value| 85.0 + value * 0.1), "running"),
            )?;
        } else {
            // Mix detached audio tracks on top of (possibly muted) video audio.
            let audio_clips: Vec<&TimelineClip> = project
                .clips
                .iter()
                .filter(|clip| {
                    track_index
                        .get(clip.track_id.as_str())
                        .is_some_and(|track| track.kind == "audio" && !track.muted)
                        && !clip.muted
                })
                .collect();
            if audio_clips.is_empty() {
                fs::copy(&video_concat, &final_path).map_err(|error| error.to_string())?;
            } else {
                let mut args = vec![
                    "-y".into(),
                    "-i".into(),
                    video_concat.display().to_string(),
                ];
                let mut filter = Vec::new();
                let mut labels = vec!["[0:a]".to_string()];
                for (index, clip) in audio_clips.iter().enumerate() {
                    let asset = asset_index
                        .get(clip.asset_id.as_str())
                        .ok_or_else(|| format!("Missing asset for clip {}", clip.id))?;
                    args.push("-i".into());
                    args.push(asset.path.clone());
                    let delay_ms = (clip.timeline_start * 1000.0).round().max(0.0) as i64;
                    let input_index = index + 1;
                    filter.push(format!(
                        "[{input_index}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,volume={:.3},adelay={delay}|{delay}[a{input_index}]",
                        clip.source_in,
                        clip.source_out,
                        clip.volume.clamp(0.0, 2.0),
                        delay = delay_ms
                    ));
                    labels.push(format!("[a{input_index}]"));
                }
                let mix = if labels.len() == 1 {
                    "anull[aout]".to_string()
                } else {
                    format!(
                        "{}amix=inputs={}:duration=first:dropout_transition=0[aout]",
                        labels.join(""),
                        labels.len()
                    )
                };
                let filter_complex = if filter.is_empty() {
                    mix
                } else {
                    format!("{};{mix}", filter.join(";"))
                };
                args.extend([
                    "-filter_complex".into(),
                    filter_complex,
                    "-map".into(),
                    "0:v:0".into(),
                    "-map".into(),
                    "[aout]".into(),
                    "-c:v".into(),
                    "copy".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "192k".into(),
                    "-shortest".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    final_path.display().to_string(),
                ]);
                emit("Mixing audio", Some(88.0), "running");
                run_ffmpeg_cancellable(
                    &ffmpeg,
                    &args,
                    job_id,
                    cancel,
                    Some(duration),
                    &|percent| emit("Mixing audio", percent.map(|value| 88.0 + value * 0.1), "running"),
                )?;
            }
        }

        let mut finished = recording;
        finished.title = format!("{} (export)", project.title);
        finished.duration_seconds = duration;
        if settings.destination_path.is_none() {
            finished.video_path = final_path.display().to_string();
            let directory = final_path
                .parent()
                .ok_or_else(|| "Invalid export path".to_string())?;
            write_video_recording(directory, &finished)?;
            Ok((final_path.display().to_string(), Some(finished.id)))
        } else {
            let _ = fs::remove_dir_all(
                PathBuf::from(&finished.video_path)
                    .parent()
                    .unwrap_or_else(|| Path::new(".")),
            );
            Ok((final_path.display().to_string(), None))
        }
    })();

    let _ = fs::remove_dir_all(&work);
    result
}

#[tauri::command]
pub async fn export_editor_project(
    app: AppHandle,
    project: VideoEditorProject,
    settings: EditorExportSettings,
) -> Result<EditorJobProgress, String> {
    validate_project(&project)?;
    let job_id = new_id("job");
    let cancel = Arc::new(AtomicBool::new(false));
    register_job(&job_id, Arc::clone(&cancel));
    emit_job(
        &app,
        EditorJobProgress {
            job_id: job_id.clone(),
            project_id: Some(project.id.clone()),
            stage: "Queued".into(),
            percent: Some(0.0),
            status: "queued".into(),
            error: None,
            result_path: None,
            result_recording_id: None,
        },
    );

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        export_project_sync(&app_clone, &project, &settings, &job_id_clone, &cancel)
    })
    .await
    .map_err(|error| error.to_string())?;

    clear_job(&job_id);
    match result {
        Ok((path, recording_id)) => {
            let progress = EditorJobProgress {
                job_id,
                project_id: None,
                stage: "Done".into(),
                percent: Some(100.0),
                status: "completed".into(),
                error: None,
                result_path: Some(path),
                result_recording_id: recording_id,
            };
            emit_job(&app, progress.clone());
            Ok(progress)
        }
        Err(error) => {
            let status = if error == "Cancelled" {
                "cancelled"
            } else {
                "failed"
            };
            let progress = EditorJobProgress {
                job_id,
                project_id: None,
                stage: if status == "cancelled" {
                    "Cancelled".into()
                } else {
                    "Failed".into()
                },
                percent: None,
                status: status.into(),
                error: Some(error.clone()),
                result_path: None,
                result_recording_id: None,
            };
            emit_job(&app, progress.clone());
            if status == "cancelled" {
                Ok(progress)
            } else {
                Err(error)
            }
        }
    }
}

#[tauri::command]
pub fn cancel_editor_job(job_id: String) -> Result<(), String> {
    let map = jobs().lock().map_err(|error| error.to_string())?;
    let Some(job) = map.get(&job_id) else {
        return Ok(());
    };
    job.cancel.store(true, Ordering::SeqCst);
    if let Ok(mut child) = job.child.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clip_duration, clip_end, default_tracks, empty_project, parse_ffmpeg_duration,
        validate_project, TimelineClip,
    };

    #[test]
    fn parse_ffmpeg_duration_should_read_timestamp() {
        let stderr = "  Duration: 00:00:12.25, start: 0.000000, bitrate: 1234 kb/s";
        assert!((parse_ffmpeg_duration(stderr).unwrap_or(0.0) - 12.25).abs() < f64::EPSILON);
    }

    #[test]
    fn validate_project_should_reject_missing_asset() {
        let mut project = empty_project("proj-1".into(), "Demo".into());
        project.tracks = default_tracks();
        project.clips.push(TimelineClip {
            id: "clip-1".into(),
            track_id: "V1".into(),
            asset_id: "missing".into(),
            timeline_start: 0.0,
            source_in: 0.0,
            source_out: 1.0,
            muted: false,
            mute_embedded_audio: false,
            volume: 1.0,
            locked: false,
        });
        assert!(validate_project(&project).is_err());
    }

    #[test]
    fn clip_helpers_should_compute_duration() {
        let clip = TimelineClip {
            id: "clip-1".into(),
            track_id: "V1".into(),
            asset_id: "asset-1".into(),
            timeline_start: 2.0,
            source_in: 1.0,
            source_out: 4.0,
            muted: false,
            mute_embedded_audio: false,
            volume: 1.0,
            locked: false,
        };
        assert!((clip_duration(&clip) - 3.0).abs() < f64::EPSILON);
        assert!((clip_end(&clip) - 5.0).abs() < f64::EPSILON);
    }
}
