#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use crossbeam_channel::{Receiver, Sender};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

const SAMPLE_RATE: u32 = 16_000;
const CLEANVOICE_BASE_URL: &str = "https://api.cleanvoice.ai/v2";
const CLEANVOICE_ACCOUNT_URL: &str = "https://api.cleanvoice.ai/v1/account";
static SESSION_METADATA_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SermonSession {
    pub id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub duration_seconds: f64,
    pub raw_audio_path: String,
    pub edited_audio_path: Option<String>,
    pub cleaned_audio_path: Option<String>,
    pub transcript: String,
    pub summary: String,
    #[serde(default)]
    pub scriptures: Vec<SermonScripture>,
    /// Legacy unclassified references. Kept only so older session files load.
    #[serde(default)]
    pub verses: Vec<String>,
    pub cleanvoice_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SermonScripture {
    pub reference: String,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub session: SermonSession,
    #[serde(skip)]
    pub audio_tx: Option<Sender<Vec<i16>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub duration_seconds: f64,
    pub peaks: Vec<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanvoiceRequest {
    pub session_id: String,
    pub api_key: String,
    pub clean_audio: bool,
    pub transcribe: bool,
    pub summarize: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiSummaryRequest {
    pub session_id: String,
    pub api_key: String,
}

fn normalize_cleanvoice_api_key(raw: &str) -> &str {
    let trimmed = raw.trim();
    let value = trimmed
        .split_once('=')
        .filter(|(name, _)| name.trim().eq_ignore_ascii_case("CLEANVOICE_API_KEY"))
        .map_or(trimmed, |(_, value)| value.trim());
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
        .trim()
}

async fn cleanvoice_json(response: reqwest::Response, action: &str) -> Result<Value, String> {
    let status = response.status();
    if status.is_success() {
        return response
            .json()
            .await
            .map_err(|error| format!("Cleanvoice returned invalid data while {action}: {error}"));
    }
    let detail = response.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(
            "Cleanvoice returned 401 for this key at its official /v1/account verification \
             endpoint. Copy the newly generated key again from \
             app.cleanvoice.ai/developer/api-keys. Do not use the masked key shown after leaving \
             the creation screen. If a newly regenerated key is also rejected, contact \
             Cleanvoice support because the rejection is coming from their authentication server."
                .to_string(),
        );
    }
    Err(format!(
        "Cleanvoice failed while {action} ({status}){}",
        if detail.trim().is_empty() {
            String::new()
        } else {
            format!(": {}", detail.trim())
        }
    ))
}

async fn ensure_cleanvoice_success(
    response: reqwest::Response,
    action: &str,
) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let detail = response.text().await.unwrap_or_default();
    Err(format!(
        "Cleanvoice failed while {action} ({status}){}",
        if detail.trim().is_empty() {
            String::new()
        } else {
            format!(": {}", detail.trim())
        }
    ))
}

async fn verify_cleanvoice_key(client: &reqwest::Client, api_key: &str) -> Result<Value, String> {
    let api_key = normalize_cleanvoice_api_key(api_key);
    let response = client
        .get(CLEANVOICE_ACCOUNT_URL)
        .header("X-API-Key", api_key)
        .send()
        .await
        .map_err(|error| format!("Could not contact Cleanvoice: {error}"))?;
    cleanvoice_json(response, "verifying the API key").await
}

#[tauri::command]
pub async fn verify_cleanvoice_api_key(api_key: String) -> Result<(), String> {
    if normalize_cleanvoice_api_key(&api_key).is_empty() {
        return Err("Enter a Cleanvoice API key first".to_string());
    }
    verify_cleanvoice_key(&reqwest::Client::new(), &api_key).await?;
    Ok(())
}

fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("sermons");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid session id".to_string());
    }
    Ok(sessions_root(app)?.join(session_id))
}

fn metadata_path(directory: &Path) -> PathBuf {
    directory.join("session.json")
}

fn read_session(directory: &Path) -> Result<SermonSession, String> {
    let json = fs::read_to_string(metadata_path(directory)).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

fn write_session(directory: &Path, session: &SermonSession) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(session).map_err(|error| error.to_string())?;
    fs::write(metadata_path(directory), json).map_err(|error| error.to_string())
}

fn mutate_session(
    directory: &Path,
    update: impl FnOnce(&mut SermonSession) -> Result<(), String>,
) -> Result<SermonSession, String> {
    let lock = SESSION_METADATA_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|error| error.to_string())?;
    let mut session = read_session(directory)?;
    update(&mut session)?;
    write_session(directory, &session)?;
    Ok(session)
}

fn source_audio_path(session: &SermonSession) -> PathBuf {
    session
        .edited_audio_path
        .as_deref()
        .map_or_else(|| PathBuf::from(&session.raw_audio_path), PathBuf::from)
}

fn next_edited_audio_path(directory: &Path) -> PathBuf {
    directory.join(format!(
        "edited-{}.wav",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

pub fn begin_recording(app: &AppHandle) -> Result<RecordingStarted, String> {
    let created_at = Utc::now();
    let id = format!(
        "{}-{}",
        created_at.format("%Y%m%d-%H%M%S"),
        created_at.timestamp_subsec_millis()
    );
    let directory = sessions_root(app)?.join(&id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let raw_audio_path = directory.join("raw.wav");
    let session = SermonSession {
        id: id.clone(),
        title: format!("Sermon — {}", created_at.format("%b %-d, %Y")),
        created_at,
        duration_seconds: 0.0,
        raw_audio_path: raw_audio_path.to_string_lossy().into_owned(),
        edited_audio_path: None,
        cleaned_audio_path: None,
        transcript: String::new(),
        summary: String::new(),
        scriptures: Vec::new(),
        verses: Vec::new(),
        cleanvoice_job_id: None,
    };
    write_session(&directory, &session)?;

    let (audio_tx, audio_rx) = crossbeam_channel::bounded::<Vec<i16>>(128);
    let writer_app = app.clone();
    let writer_session = session.clone();
    std::thread::Builder::new()
        .name("sermon-recorder".into())
        .spawn(move || record_wav(writer_app, writer_session, audio_rx))
        .map_err(|error| error.to_string())?;

    Ok(RecordingStarted {
        session,
        audio_tx: Some(audio_tx),
    })
}

fn record_wav(app: AppHandle, session: SermonSession, audio_rx: Receiver<Vec<i16>>) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let path = PathBuf::from(&session.raw_audio_path);
    let file = match File::create(&path) {
        Ok(file) => file,
        Err(error) => {
            log::error!("[RECORDING] Could not create {}: {error}", path.display());
            return;
        }
    };
    let mut writer = match hound::WavWriter::new(BufWriter::new(file), spec) {
        Ok(writer) => writer,
        Err(error) => {
            log::error!("[RECORDING] Could not initialize WAV writer: {error}");
            return;
        }
    };
    let mut sample_count: u64 = 0;

    while let Ok(samples) = audio_rx.recv() {
        for sample in samples {
            if writer.write_sample(sample).is_err() {
                log::error!("[RECORDING] WAV write failed");
                return;
            }
            sample_count = sample_count.saturating_add(1);
        }
    }

    if let Err(error) = writer.finalize() {
        log::error!("[RECORDING] Could not finalize WAV: {error}");
        return;
    }
    let duration_seconds = sample_count as f64 / f64::from(SAMPLE_RATE);
    let mut completed_session = session.clone();
    if let Ok(directory) = session_dir(&app, &session.id) {
        match mutate_session(&directory, |current| {
            current.duration_seconds = duration_seconds;
            Ok(())
        }) {
            Ok(current) => completed_session = current,
            Err(error) => {
                log::error!("[RECORDING] Could not update session: {error}");
            }
        }
    }
    let _ = app.emit("sermon_recording_saved", &completed_session);
    log::info!(
        "[RECORDING] Saved {:.1}s to {}",
        duration_seconds,
        path.display()
    );
}

#[tauri::command]
pub fn list_sermon_sessions(app: AppHandle) -> Result<Vec<SermonSession>, String> {
    let root = sessions_root(&app)?;
    let mut sessions = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| read_session(&entry.path()).ok())
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(sessions)
}

#[tauri::command]
pub fn rename_sermon_session(
    app: AppHandle,
    session_id: String,
    title: String,
) -> Result<SermonSession, String> {
    let directory = session_dir(&app, &session_id)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("Session title cannot be empty".to_string());
    }
    mutate_session(&directory, |session| {
        session.title = title.to_string();
        Ok(())
    })
}

#[tauri::command]
pub fn append_sermon_transcript(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let directory = session_dir(&app, &session_id)?;
    let text = text.trim();
    if !text.is_empty() {
        mutate_session(&directory, |session| {
            if !session.transcript.is_empty() {
                session.transcript.push('\n');
            }
            session.transcript.push_str(text);
            Ok(())
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn append_sermon_scriptures(
    app: AppHandle,
    session_id: String,
    scriptures: Vec<SermonScripture>,
) -> Result<(), String> {
    let directory = session_dir(&app, &session_id)?;
    mutate_session(&directory, |session| {
        for scripture in scriptures {
            let reference = scripture.reference.trim();
            let source = scripture.source.trim();
            if reference.is_empty() || !matches!(source, "ai-direct" | "queued") {
                continue;
            }
            if source == "ai-direct" {
                session.scriptures.retain(|existing| {
                    existing.reference != reference || existing.source == "ai-direct"
                });
            } else if session
                .scriptures
                .iter()
                .any(|existing| existing.reference == reference && existing.source == "ai-direct")
            {
                continue;
            }
            if !session
                .scriptures
                .iter()
                .any(|existing| existing.reference == reference && existing.source == source)
            {
                session.scriptures.push(SermonScripture {
                    reference: reference.to_string(),
                    source: source.to_string(),
                });
            }
        }
        Ok(())
    })
    .map(|_| ())
}

#[tauri::command]
pub fn analyze_sermon_audio(
    app: AppHandle,
    session_id: String,
    points: Option<usize>,
) -> Result<WaveformData, String> {
    let directory = session_dir(&app, &session_id)?;
    let session = read_session(&directory)?;
    let path = source_audio_path(&session);
    analyze_wav(&path, points.unwrap_or(900).clamp(100, 4_000))
}

fn analyze_wav(path: &Path, points: usize) -> Result<WaveformData, String> {
    let mut reader = hound::WavReader::open(path).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let total_samples = reader.duration() as usize;
    let samples_per_point = (total_samples / points).max(1);
    let mut peaks = Vec::with_capacity(points);
    let mut peak = 0.0_f32;
    let mut count = 0_usize;

    for sample in reader.samples::<i16>() {
        let amplitude =
            f32::from(sample.map_err(|error| error.to_string())?).abs() / f32::from(i16::MAX);
        peak = peak.max(amplitude);
        count += 1;
        if count >= samples_per_point {
            peaks.push(peak);
            peak = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        peaks.push(peak);
    }
    Ok(WaveformData {
        duration_seconds: total_samples as f64
            / (f64::from(spec.sample_rate) * f64::from(spec.channels)),
        peaks,
    })
}

#[tauri::command]
pub fn trim_sermon_audio(
    app: AppHandle,
    session_id: String,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<SermonSession, String> {
    let directory = session_dir(&app, &session_id)?;
    let mut session = read_session(&directory)?;
    let source = source_audio_path(&session);
    let destination = next_edited_audio_path(&directory);
    trim_wav(&source, &destination, start_seconds, end_seconds)?;
    if session.edited_audio_path.is_some() && source != destination {
        let _ = fs::remove_file(&source);
    }
    session.edited_audio_path = Some(destination.to_string_lossy().into_owned());
    session.cleaned_audio_path = None;
    session.duration_seconds = end_seconds - start_seconds;
    write_session(&directory, &session)?;
    Ok(session)
}

#[tauri::command]
pub fn cut_sermon_audio(
    app: AppHandle,
    session_id: String,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<SermonSession, String> {
    let directory = session_dir(&app, &session_id)?;
    let mut session = read_session(&directory)?;
    let source = source_audio_path(&session);
    let destination = next_edited_audio_path(&directory);
    let duration = cut_wav(&source, &destination, start_seconds, end_seconds)?;
    if session.edited_audio_path.is_some() && source != destination {
        let _ = fs::remove_file(&source);
    }
    session.edited_audio_path = Some(destination.to_string_lossy().into_owned());
    session.cleaned_audio_path = None;
    session.duration_seconds = duration;
    write_session(&directory, &session)?;
    Ok(session)
}

fn trim_wav(
    source: &Path,
    destination: &Path,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<(), String> {
    if !start_seconds.is_finite()
        || !end_seconds.is_finite()
        || start_seconds < 0.0
        || end_seconds <= start_seconds
    {
        return Err("Invalid trim range".to_string());
    }
    let mut reader = hound::WavReader::open(source).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let total_frames = f64::from(reader.duration()) / f64::from(spec.channels);
    let duration = total_frames / f64::from(spec.sample_rate);
    if end_seconds > duration + 0.01 {
        return Err("Trim end exceeds recording duration".to_string());
    }
    let start_sample =
        (start_seconds * f64::from(spec.sample_rate) * f64::from(spec.channels)) as u64;
    let end_sample = (end_seconds * f64::from(spec.sample_rate) * f64::from(spec.channels)) as u64;
    let writer_file = File::create(destination).map_err(|error| error.to_string())?;
    let mut writer =
        hound::WavWriter::new(BufWriter::new(writer_file), spec).map_err(|e| e.to_string())?;
    for (index, sample) in reader.samples::<i16>().enumerate() {
        let index = index as u64;
        if index < start_sample {
            continue;
        }
        if index >= end_sample {
            break;
        }
        writer
            .write_sample(sample.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())
}

fn cut_wav(
    source: &Path,
    destination: &Path,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<f64, String> {
    if !start_seconds.is_finite()
        || !end_seconds.is_finite()
        || start_seconds < 0.0
        || end_seconds <= start_seconds
    {
        return Err("Invalid cut range".to_string());
    }
    let mut reader = hound::WavReader::open(source).map_err(|error| error.to_string())?;
    let spec = reader.spec();
    let total_samples = u64::from(reader.duration());
    let samples_per_second = f64::from(spec.sample_rate) * f64::from(spec.channels);
    let duration = total_samples as f64 / samples_per_second;
    if end_seconds > duration + 0.01 {
        return Err("Cut end exceeds recording duration".to_string());
    }
    let start_sample = (start_seconds * samples_per_second) as u64;
    let end_sample = (end_seconds * samples_per_second) as u64;
    let writer_file = File::create(destination).map_err(|error| error.to_string())?;
    let mut writer =
        hound::WavWriter::new(BufWriter::new(writer_file), spec).map_err(|e| e.to_string())?;
    for (index, sample) in reader.samples::<i16>().enumerate() {
        let index = index as u64;
        if index >= start_sample && index < end_sample {
            continue;
        }
        writer
            .write_sample(sample.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())?;
    Ok(duration - (end_seconds - start_seconds))
}

#[tauri::command]
pub fn delete_sermon_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let directory = session_dir(&app, &session_id)?;
    fs::remove_dir_all(directory).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn process_with_cleanvoice(
    app: AppHandle,
    request: CleanvoiceRequest,
) -> Result<SermonSession, String> {
    let api_key = normalize_cleanvoice_api_key(&request.api_key).to_string();
    if api_key.is_empty() {
        return Err("Add your Cleanvoice API key in Settings first".to_string());
    }
    let directory = session_dir(&app, &request.session_id)?;
    let mut session = read_session(&directory)?;
    let source = source_audio_path(&session);
    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sermon.wav");
    let client = reqwest::Client::new();
    verify_cleanvoice_key(&client, &api_key).await?;

    app.emit(
        "cleanvoice_progress",
        serde_json::json!({ "sessionId": request.session_id, "stage": "Uploading audio" }),
    )
    .map_err(|error| error.to_string())?;
    let upload_response = client
        .post(format!("{CLEANVOICE_BASE_URL}/upload"))
        .query(&[("filename", filename)])
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|error| format!("Could not contact Cleanvoice: {error}"))?;
    let upload = cleanvoice_json(upload_response, "requesting an upload URL").await?;
    let signed_url = upload
        .get("signedUrl")
        .or_else(|| upload.get("signed_url"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Cleanvoice did not return an upload URL".to_string())?;
    let file_url = signed_url.split('?').next().unwrap_or(signed_url);
    let bytes = tokio::fs::read(&source)
        .await
        .map_err(|error| error.to_string())?;
    let storage_response = client
        .put(signed_url)
        .header("Content-Type", "audio/wav")
        .body(bytes)
        .send()
        .await
        .map_err(|error| format!("Could not upload audio to Cleanvoice storage: {error}"))?;
    ensure_cleanvoice_success(storage_response, "uploading the audio file").await?;

    app.emit(
        "cleanvoice_progress",
        serde_json::json!({ "sessionId": request.session_id, "stage": "Starting Cleanvoice job" }),
    )
    .map_err(|error| error.to_string())?;
    let edit_body = serde_json::json!({
        "input": {
            "files": [file_url],
            "config": {
                "fillers": request.clean_audio,
                "long_silences": request.clean_audio,
                "mouth_sounds": request.clean_audio,
                "stutters": request.clean_audio,
                "breath": request.clean_audio,
                "remove_noise": request.clean_audio,
                "studio_sound": request.clean_audio,
                "normalize": request.clean_audio,
                "transcription": request.transcribe || request.summarize,
                "summarize": request.summarize
            }
        }
    });
    let create_response = client
        .post(format!("{CLEANVOICE_BASE_URL}/edits"))
        .header("X-API-Key", &api_key)
        .json(&edit_body)
        .send()
        .await
        .map_err(|error| format!("Could not contact Cleanvoice: {error}"))?;
    let created = cleanvoice_json(create_response, "starting the edit job").await?;
    let job_id = created
        .get("id")
        .or_else(|| created.get("edit_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Cleanvoice did not return a job id".to_string())?
        .to_string();
    session.cleanvoice_job_id = Some(job_id.clone());
    write_session(&directory, &session)?;

    let result = poll_cleanvoice(&client, &api_key, &job_id, &app, &request.session_id).await?;
    fs::write(
        directory.join("cleanvoice-result.json"),
        serde_json::to_vec_pretty(&result).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    if let Some(transcript) = extract_cleanvoice_transcript(&result) {
        session.transcript = transcript;
    }
    if let Some(summary) = extract_cleanvoice_summary(&result) {
        session.summary = summary;
    }
    if request.clean_audio {
        if let Some(url) = result
            .pointer("/result/download_url")
            .and_then(Value::as_str)
        {
            let response = client
                .get(url)
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?;
            let extension = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.contains("mpeg"))
                .map_or("wav", |_| "mp3");
            let cleaned = directory.join(format!("cleaned.{extension}"));
            tokio::fs::write(&cleaned, response.bytes().await.map_err(|e| e.to_string())?)
                .await
                .map_err(|error| error.to_string())?;
            session.cleaned_audio_path = Some(cleaned.to_string_lossy().into_owned());
        }
    }
    write_session(&directory, &session)?;
    let _ = app.emit("cleanvoice_complete", &session);
    Ok(session)
}

async fn poll_cleanvoice(
    client: &reqwest::Client,
    api_key: &str,
    job_id: &str,
    app: &AppHandle,
    session_id: &str,
) -> Result<Value, String> {
    for _ in 0..1_440 {
        let response = client
            .get(format!("{CLEANVOICE_BASE_URL}/edits/{job_id}"))
            .header("X-API-Key", api_key.trim())
            .send()
            .await
            .map_err(|error| format!("Could not contact Cleanvoice: {error}"))?;
        let result = cleanvoice_json(response, "checking edit progress").await?;
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("PENDING");
        let _ = app.emit(
            "cleanvoice_progress",
            serde_json::json!({ "sessionId": session_id, "stage": status }),
        );
        match status {
            "SUCCESS" => return Ok(result),
            "FAILURE" => {
                return Err(result.get("error").map_or_else(
                    || "Cleanvoice processing failed".to_string(),
                    Value::to_string,
                ));
            }
            _ => tokio::time::sleep(Duration::from_secs(5)).await,
        }
    }
    Err("Cleanvoice processing timed out".to_string())
}

fn extract_cleanvoice_transcript(result: &Value) -> Option<String> {
    let paragraphs = result
        .pointer("/result/transcription/paragraphs")?
        .as_array()?;
    let text = paragraphs
        .iter()
        .filter_map(|paragraph| paragraph.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn extract_cleanvoice_summary(result: &Value) -> Option<String> {
    let summarization = result.pointer("/result/summarization")?;
    let mut sections = Vec::new();
    if let Some(summary) = summarization
        .get("summary")
        .or_else(|| summarization.get("summary_of_summary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        sections.push(format!("Sermon Summary\n{summary}"));
    }
    if let Some(learnings) = summarization
        .get("key_learnings")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        sections.push(format!("Key Learnings\n{learnings}"));
    }
    if let Some(chapters) = summarization.get("chapters").and_then(Value::as_array) {
        let outline = chapters
            .iter()
            .filter_map(|chapter| {
                let title = chapter.get("title")?.as_str()?;
                let start = chapter.get("start").and_then(Value::as_f64).unwrap_or(0.0);
                let minutes = (start / 60.0).floor() as u64;
                let seconds = (start % 60.0).floor() as u64;
                Some(format!("• {minutes:02}:{seconds:02} — {title}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !outline.is_empty() {
            sections.push(format!("Sermon Outline\n{outline}"));
        }
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

#[tauri::command]
pub async fn generate_openai_sermon_summary(
    app: AppHandle,
    request: OpenAiSummaryRequest,
) -> Result<SermonSession, String> {
    if request.api_key.trim().is_empty() {
        return Err("Add your OpenAI API key in Settings first".to_string());
    }
    let directory = session_dir(&app, &request.session_id)?;
    let mut session = read_session(&directory)?;
    if session.transcript.trim().is_empty() {
        return Err("Transcribe this recording before generating sermon notes".to_string());
    }

    let scriptures = if session.scriptures.is_empty() {
        "No scripture references were captured during the live session.".to_string()
    } else {
        session
            .scriptures
            .iter()
            .map(|scripture| {
                let source = if scripture.source == "ai-direct" {
                    "direct AI hit"
                } else {
                    "queued or manually added"
                };
                format!("- {} ({source})", scripture.reference)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let prompt = format!(
        "SERMON TITLE:\n{}\n\nSCRIPTURES CAPTURED BY RHEMA:\n{}\n\nTRANSCRIPT:\n{}",
        session.title, scriptures, session.transcript
    );
    let body = serde_json::json!({
        "model": "gpt-5-mini",
        "store": false,
        "instructions": concat!(
            "You are an experienced Christian sermon-notes editor. Turn the supplied sermon ",
            "transcript into faithful, congregation-ready notes. Do not invent quotations, ",
            "scriptures, names, claims, or applications. Correct obvious transcription errors ",
            "only when the intended wording is clear. Use Markdown with exactly these sections: ",
            "# Sermon Summary, ## Central Theme, ## Sermon Outline, ## Key Scriptures, ",
            "## Key Lessons, ## Practical Application, ## Closing Reflection. ",
            "Integrate only scripture references supported by the transcript or the captured list. ",
            "Use concise pastoral language and preserve the preacher's meaning."
        ),
        "input": prompt
    });
    let response: Value = reqwest::Client::new()
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(request.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let summary = extract_openai_output_text(&response)
        .ok_or_else(|| "OpenAI returned no summary text".to_string())?;
    session.summary = summary;
    write_session(&directory, &session)?;
    let _ = app.emit("openai_summary_complete", &session);
    Ok(session)
}

fn extract_openai_output_text(response: &Value) -> Option<String> {
    if let Some(text) = response
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    let output = response.get("output")?.as_array()?;
    let text = output
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

#[tauri::command]
pub fn update_sermon_summary(
    app: AppHandle,
    session_id: String,
    summary: String,
) -> Result<SermonSession, String> {
    let directory = session_dir(&app, &session_id)?;
    mutate_session(&directory, |session| {
        session.summary = summary.trim().to_string();
        Ok(())
    })
}

#[tauri::command]
pub fn save_sermon_summary_as_note(
    app: AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let directory = session_dir(&app, &session_id)?;
    let session = read_session(&directory)?;
    if session.summary.trim().is_empty() {
        return Err("Generate a summary before saving it as a note".to_string());
    }
    let verses = if session.scriptures.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nScriptures\n{}",
            session
                .scriptures
                .iter()
                .map(|scripture| format!("• {}", scripture.reference))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Ok(serde_json::json!({
        "title": session.title,
        "body": format!("{}{}", session.summary, verses)
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_wav, cut_wav, extract_cleanvoice_summary, extract_cleanvoice_transcript,
        extract_openai_output_text, normalize_cleanvoice_api_key, trim_wav,
    };
    use std::fs::File;
    use std::io::BufWriter;

    fn temporary_wav(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "rhema-{name}-{}-{}.wav",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    #[test]
    fn trim_wav_should_keep_requested_range() {
        let source = temporary_wav("source");
        let destination = temporary_wav("trimmed");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 1_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let file = File::create(&source).unwrap();
        let mut writer = hound::WavWriter::new(BufWriter::new(file), spec).unwrap();
        for _ in 0..2_000 {
            writer.write_sample(1_000_i16).unwrap();
        }
        writer.finalize().unwrap();

        trim_wav(&source, &destination, 0.5, 1.5).unwrap();
        let waveform = analyze_wav(&destination, 100).unwrap();

        assert!((waveform.duration_seconds - 1.0).abs() < 0.001);
        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn cleanvoice_result_should_format_transcript_and_summary() {
        let result = serde_json::json!({
            "result": {
                "transcription": {
                    "paragraphs": [
                        { "text": "Faith comes by hearing." },
                        { "text": "We walk by faith." }
                    ]
                },
                "summarization": {
                    "summary": "A message about living by faith.",
                    "key_learnings": "- Trust God\n- Hear the Word",
                    "chapters": [{ "start": 65.0, "title": "Walking by faith" }]
                }
            }
        });

        assert_eq!(
            extract_cleanvoice_transcript(&result).as_deref(),
            Some("Faith comes by hearing.\n\nWe walk by faith.")
        );
        assert!(extract_cleanvoice_summary(&result)
            .is_some_and(|summary| summary.contains("01:05 — Walking by faith")));
    }

    #[test]
    fn cut_wav_should_remove_requested_range() {
        let source = temporary_wav("cut-source");
        let destination = temporary_wav("cut-edited");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 1_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let file = File::create(&source).unwrap();
        let mut writer = hound::WavWriter::new(BufWriter::new(file), spec).unwrap();
        for _ in 0..2_000 {
            writer.write_sample(1_000_i16).unwrap();
        }
        writer.finalize().unwrap();

        let duration = cut_wav(&source, &destination, 0.5, 1.5).unwrap();
        let waveform = analyze_wav(&destination, 100).unwrap();

        assert!((duration - 1.0).abs() < 0.001);
        assert!((waveform.duration_seconds - 1.0).abs() < 0.001);
        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(destination);
    }

    #[test]
    fn openai_response_should_extract_output_text() {
        let response = serde_json::json!({
            "output": [{
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "# Sermon Summary\nLive by faith." }
                ]
            }]
        });
        assert_eq!(
            extract_openai_output_text(&response).as_deref(),
            Some("# Sermon Summary\nLive by faith.")
        );
    }

    #[test]
    fn cleanvoice_key_should_normalize_common_copy_formats() {
        assert_eq!(
            normalize_cleanvoice_api_key(" CLEANVOICE_API_KEY=\"cv_example\" "),
            "cv_example"
        );
        assert_eq!(normalize_cleanvoice_api_key("'cv_example'"), "cv_example");
        assert_eq!(normalize_cleanvoice_api_key("cv_example"), "cv_example");
    }
}
