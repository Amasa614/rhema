#![expect(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors require pass-by-value"
)]

use std::{fs, path::Path, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::postproduction::clean_wav_file;
use super::stream::{
    create_video_recording, find_ffmpeg, read_video_recording, run_ffmpeg, sanitize_ffmpeg_error,
    video_dir, write_video_recording, VideoRecording,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoRange {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAudio {
    pub recording_id: String,
    pub audio_path: String,
}

fn ffmpeg_bin(app: &AppHandle) -> Result<PathBuf, String> {
    find_ffmpeg(app).ok_or_else(|| {
        "FFmpeg not found. Install it with winget install FFmpeg or set FFMPEG_PATH.".to_string()
    })
}

fn require_finished_recording(app: &AppHandle, recording_id: &str) -> Result<VideoRecording, String> {
    let directory = video_dir(app, recording_id)?;
    let recording = read_video_recording(&directory)?;
    if !Path::new(&recording.video_path).is_file() {
        return Err("This video file is not ready yet. Stop recording first.".to_string());
    }
    Ok(recording)
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

fn probe_input(ffmpeg: &Path, input: &Path) -> (f64, bool) {
    let output = run_ffmpeg(
        ffmpeg,
        &[
            "-hide_banner".into(),
            "-i".into(),
            input.display().to_string(),
        ],
    )
    .ok();
    let stderr = output
        .map(|result| String::from_utf8_lossy(&result.stderr).into_owned())
        .unwrap_or_default();
    let duration = parse_ffmpeg_duration(&stderr).unwrap_or(0.0);
    let has_audio = stderr.contains("Audio:");
    (duration, has_audio)
}

fn run_or_fail(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let output = run_ffmpeg(ffmpeg, args)?;
    if output.status.success() {
        return Ok(());
    }
    Err(sanitize_ffmpeg_error(&String::from_utf8_lossy(&output.stderr)))
}

fn encode_range(
    ffmpeg: &Path,
    input: &Path,
    start: f64,
    end: f64,
    has_audio: bool,
    output: &Path,
) -> Result<(), String> {
    if !start.is_finite() || !end.is_finite() || end <= start {
        return Err("Invalid edit range".to_string());
    }
    let duration = end - start;
    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input.display().to_string(),
        "-ss".into(),
        format!("{start:.3}"),
        "-t".into(),
        format!("{duration:.3}"),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "23".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    if has_audio {
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    } else {
        args.push("-an".into());
    }
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        output.display().to_string(),
    ]);
    run_or_fail(ffmpeg, &args)
}

fn concat_mp4(ffmpeg: &Path, parts: &[PathBuf], output: &Path) -> Result<(), String> {
    if parts.len() == 1 {
        fs::copy(&parts[0], output).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let list_path = output.with_extension("concat.txt");
    let list = parts
        .iter()
        .map(|path| format!("file '{}'", path.display().to_string().replace('\\', "/")))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&list_path, list).map_err(|error| error.to_string())?;
    let result = run_or_fail(
        ffmpeg,
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
            output.display().to_string(),
        ],
    );
    let _ = fs::remove_file(list_path);
    result
}

fn emit_progress(app: &AppHandle, recording_id: &str, stage: &str) {
    let _ = app.emit(
        "video_edit_progress",
        serde_json::json!({ "recordingId": recording_id, "stage": stage }),
    );
}

fn start_edit_recording(app: &AppHandle) -> Result<VideoRecording, String> {
    create_video_recording(app, "mp4")
}

fn abandon_edit(app: &AppHandle, recording: &VideoRecording) {
    if let Ok(directory) = video_dir(app, &recording.id) {
        let _ = fs::remove_dir_all(directory);
    }
}

fn finish_edit(
    app: &AppHandle,
    source: &VideoRecording,
    mut output: VideoRecording,
    suffix: &str,
    duration: f64,
) -> Result<VideoRecording, String> {
    output.title = format!("{} ({suffix})", source.title);
    output.duration_seconds = duration.max(0.0);
    let directory = video_dir(app, &output.id)?;
    write_video_recording(&directory, &output)?;
    Ok(output)
}

#[tauri::command]
pub fn video_keep_range(
    app: AppHandle,
    recording_id: String,
    range: VideoRange,
) -> Result<VideoRecording, String> {
    let source = require_finished_recording(&app, &recording_id)?;
    let ffmpeg = ffmpeg_bin(&app)?;
    let input = PathBuf::from(&source.video_path);
    let (probed, has_audio) = probe_input(&ffmpeg, &input);
    let duration = if source.duration_seconds > 0.1 {
        source.duration_seconds
    } else {
        probed
    };
    if range.end_seconds > duration + 0.25 {
        return Err("Keep range is past the end of the video".to_string());
    }
    let output = start_edit_recording(&app)?;
    if let Err(error) = encode_range(
        &ffmpeg,
        &input,
        range.start_seconds,
        range.end_seconds,
        has_audio,
        Path::new(&output.video_path),
    ) {
        abandon_edit(&app, &output);
        return Err(error);
    }
    finish_edit(
        &app,
        &source,
        output,
        "kept",
        range.end_seconds - range.start_seconds,
    )
}

#[tauri::command]
pub fn video_cut_range(
    app: AppHandle,
    recording_id: String,
    range: VideoRange,
) -> Result<VideoRecording, String> {
    let source = require_finished_recording(&app, &recording_id)?;
    let ffmpeg = ffmpeg_bin(&app)?;
    let input = PathBuf::from(&source.video_path);
    let (probed, has_audio) = probe_input(&ffmpeg, &input);
    let duration = if source.duration_seconds > 0.1 {
        source.duration_seconds
    } else {
        probed
    };
    if range.start_seconds <= 0.05 && range.end_seconds >= duration - 0.05 {
        return Err("That would delete the whole video".to_string());
    }
    let output = start_edit_recording(&app)?;
    let work = video_dir(&app, &output.id)?;
    let mut parts = Vec::new();
    if range.start_seconds > 0.05 {
        let part = work.join("part-a.mp4");
        encode_range(&ffmpeg, &input, 0.0, range.start_seconds, has_audio, &part)?;
        parts.push(part);
    }
    if range.end_seconds < duration - 0.05 {
        let part = work.join("part-b.mp4");
        encode_range(&ffmpeg, &input, range.end_seconds, duration, has_audio, &part)?;
        parts.push(part);
    }
    concat_mp4(&ffmpeg, &parts, Path::new(&output.video_path))?;
    for part in &parts {
        let _ = fs::remove_file(part);
    }
    finish_edit(
        &app,
        &source,
        output,
        "cut",
        (duration - (range.end_seconds - range.start_seconds)).max(0.0),
    )
}

#[tauri::command]
pub fn video_extract_audio(
    app: AppHandle,
    recording_id: String,
) -> Result<ExtractedAudio, String> {
    let source = require_finished_recording(&app, &recording_id)?;
    let ffmpeg = ffmpeg_bin(&app)?;
    let input = PathBuf::from(&source.video_path);
    let (_, has_audio) = probe_input(&ffmpeg, &input);
    if !has_audio {
        return Err("This video has no audio track to extract".to_string());
    }
    let directory = video_dir(&app, &recording_id)?;
    let audio_path = directory.join("extracted-audio.wav");
    run_or_fail(
        &ffmpeg,
        &[
            "-y".into(),
            "-i".into(),
            input.display().to_string(),
            "-vn".into(),
            "-ac".into(),
            "2".into(),
            "-ar".into(),
            "48000".into(),
            audio_path.display().to_string(),
        ],
    )?;
    Ok(ExtractedAudio {
        recording_id,
        audio_path: audio_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn video_replace_audio(
    app: AppHandle,
    recording_id: String,
    audio_path: String,
    mix: bool,
) -> Result<VideoRecording, String> {
    let source = require_finished_recording(&app, &recording_id)?;
    let ffmpeg = ffmpeg_bin(&app)?;
    let audio = PathBuf::from(&audio_path);
    if !audio.is_file() {
        return Err("Choose an audio file first".to_string());
    }
    let input = PathBuf::from(&source.video_path);
    let (_, has_audio) = probe_input(&ffmpeg, &input);
    let output = start_edit_recording(&app)?;
    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input.display().to_string(),
        "-i".into(),
        audio.display().to_string(),
    ];
    if mix && has_audio {
        args.extend([
            "-filter_complex".into(),
            "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]".into(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "[a]".into(),
        ]);
    } else {
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
            "-shortest".into(),
        ]);
    }
    args.extend([
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
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        output.video_path.clone(),
    ]);
    run_or_fail(&ffmpeg, &args)?;
    let (duration, _) = probe_input(&ffmpeg, Path::new(&output.video_path));
    finish_edit(
        &app,
        &source,
        output,
        if mix { "mixed audio" } else { "new audio" },
        duration,
    )
}

#[tauri::command]
pub fn video_overlay_image(
    app: AppHandle,
    recording_id: String,
    image_path: String,
) -> Result<VideoRecording, String> {
    let source = require_finished_recording(&app, &recording_id)?;
    let ffmpeg = ffmpeg_bin(&app)?;
    let image = PathBuf::from(&image_path);
    if !image.is_file() {
        return Err("Choose an image first".to_string());
    }
    let input = PathBuf::from(&source.video_path);
    let (duration, has_audio) = probe_input(&ffmpeg, &input);
    let output = start_edit_recording(&app)?;
    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input.display().to_string(),
        "-i".into(),
        image.display().to_string(),
        "-filter_complex".into(),
        "[1:v]format=rgba,scale=320:-1[ov];[0:v][ov]overlay=24:24:format=auto".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "23".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    if has_audio {
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    } else {
        args.push("-an".into());
    }
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        output.video_path.clone(),
    ]);
    run_or_fail(&ffmpeg, &args)?;
    finish_edit(&app, &source, output, "overlay", duration)
}

#[tauri::command]
pub async fn video_clean_audio(
    app: AppHandle,
    recording_id: String,
    api_key: String,
) -> Result<VideoRecording, String> {
    let source = require_finished_recording(&app, &recording_id)?;
    let ffmpeg = ffmpeg_bin(&app)?;
    let input = PathBuf::from(&source.video_path);
    let (duration, has_audio) = probe_input(&ffmpeg, &input);
    if !has_audio {
        return Err("This video has no audio track to clean".to_string());
    }
    let work = video_dir(&app, &recording_id)?;
    let extracted = work.join("clean-source.wav");
    let cleaned = work.join("clean-output.wav");
    emit_progress(&app, &recording_id, "Extracting audio");
    run_or_fail(
        &ffmpeg,
        &[
            "-y".into(),
            "-i".into(),
            input.display().to_string(),
            "-vn".into(),
            "-ac".into(),
            "2".into(),
            "-ar".into(),
            "48000".into(),
            extracted.display().to_string(),
        ],
    )?;
    let app_for_stage = app.clone();
    let recording_id_for_stage = recording_id.clone();
    clean_wav_file(&api_key, &extracted, &cleaned, move |stage| {
        emit_progress(&app_for_stage, &recording_id_for_stage, stage);
    })
    .await?;
    emit_progress(&app, &recording_id, "Putting cleaned audio back on the video");
    let output = start_edit_recording(&app)?;
    run_or_fail(
        &ffmpeg,
        &[
            "-y".into(),
            "-i".into(),
            input.display().to_string(),
            "-i".into(),
            cleaned.display().to_string(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
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
            "-b:a".into(),
            "192k".into(),
            "-shortest".into(),
            "-movflags".into(),
            "+faststart".into(),
            output.video_path.clone(),
        ],
    )?;
    let _ = fs::remove_file(extracted);
    finish_edit(&app, &source, output, "cleaned audio", duration)
}

#[cfg(test)]
mod tests {
    use super::parse_ffmpeg_duration;

    #[test]
    fn parse_ffmpeg_duration_should_read_timestamp() {
        let stderr = "  Duration: 00:01:02.50, start: 0.000000, bitrate: 1234 kb/s";
        assert!((parse_ffmpeg_duration(stderr).unwrap_or(0.0) - 62.5).abs() < f64::EPSILON);
    }
}
