use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoEncoder {
    Nvenc,
    X264,
}

#[derive(Debug, Clone)]
pub struct StreamEncodeRequest {
    pub video_device: Option<String>,
    pub audio_device: Option<String>,
    pub overlay_path: Option<PathBuf>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_bitrate_kbps: u32,
    pub encoder: VideoEncoder,
    pub destination: Option<String>,
    pub record_path: Option<PathBuf>,
}

/// Combine ingest URL and stream key without logging the key.
pub fn join_rtmp_url(server: &str, stream_key: &str) -> Result<String, String> {
    let server = server.trim();
    let key = stream_key.trim();
    if server.is_empty() {
        return Err("RTMP server URL is required".into());
    }
    if !(server.starts_with("rtmp://") || server.starts_with("rtmps://")) {
        return Err("Server URL must start with rtmp:// or rtmps://".into());
    }
    if key.is_empty() {
        return Ok(server.to_string());
    }
    if server.ends_with('/') {
        Ok(format!("{server}{key}"))
    } else {
        Ok(format!("{server}/{key}"))
    }
}

pub fn build_ffmpeg_args(request: &StreamEncodeRequest) -> Result<Vec<String>, String> {
    if request.width < 160 || request.height < 90 {
        return Err("Stream resolution is too small".into());
    }
    let fps = request.fps.clamp(15, 60);
    let bitrate = request.video_bitrate_kbps.clamp(1500, 12_000);
    let gop = fps * 2;
    let size = format!("{}x{}", request.width, request.height);

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "warning".into()];
    let mut next_input: u32 = 0;
    let video_input: u32;
    let mut audio_on_video_input = false;

    if let Some(video) = request.video_device.as_deref() {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-rtbufsize".into(),
            "256M".into(),
            "-framerate".into(),
            fps.to_string(),
            "-i".into(),
            dshow_input(video, request.audio_device.as_deref()),
        ]);
        video_input = next_input;
        audio_on_video_input = request.audio_device.is_some();
        next_input += 1;
    } else {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("color=c=black:s={size}:r={fps},format=yuv420p"),
        ]);
        video_input = next_input;
        next_input += 1;
    }

    let overlay_input = if let Some(overlay) = &request.overlay_path {
        args.extend([
            "-f".into(),
            "image2".into(),
            "-loop".into(),
            "1".into(),
            "-framerate".into(),
            "5".into(),
            "-i".into(),
            overlay.to_string_lossy().into_owned(),
        ]);
        let index = next_input;
        next_input += 1;
        Some(index)
    } else {
        None
    };

    let audio_input = if audio_on_video_input {
        Some(video_input)
    } else if let Some(audio) = request.audio_device.as_deref() {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio={audio}"),
        ]);
        let index = next_input;
        next_input += 1;
        Some(index)
    } else {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
        ]);
        let index = next_input;
        Some(index)
    };
    let _ = next_input;

    let mut filter = format!(
        "[{video_input}:v]scale={size}:force_original_aspect_ratio=decrease,pad={size}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p[base]"
    );
    let mut video_map = "[base]".to_string();
    if let Some(overlay_index) = overlay_input {
        filter.push_str(&format!(
            ";[{overlay_index}:v]format=rgba,scale={size}[ov];[base][ov]overlay=0:0:format=auto[v]"
        ));
        video_map = "[v]".into();
    }

    args.extend(["-filter_complex".into(), filter]);
    args.extend(["-map".into(), video_map]);
    args.extend([
        "-map".into(),
        format!("{}:a?", audio_input.unwrap_or(0)),
    ]);

    match request.encoder {
        VideoEncoder::Nvenc => {
            args.extend([
                "-c:v".into(),
                "h264_nvenc".into(),
                "-preset".into(),
                "p4".into(),
                "-tune".into(),
                "ll".into(),
            ]);
        }
        VideoEncoder::X264 => {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-tune".into(),
                "zerolatency".into(),
            ]);
        }
    }

    args.extend([
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-b:v".into(),
        format!("{bitrate}k"),
        "-maxrate".into(),
        format!("{bitrate}k"),
        "-bufsize".into(),
        format!("{}k", bitrate * 2),
        "-g".into(),
        gop.to_string(),
        "-keyint_min".into(),
        gop.to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
    ]);
    push_outputs(&mut args, request)?;

    Ok(args)
}

fn push_outputs(args: &mut Vec<String>, request: &StreamEncodeRequest) -> Result<(), String> {
    match (
        request.destination.as_deref(),
        request.record_path.as_deref(),
    ) {
        (None, None) => Err("A stream destination or a local recording path is required".into()),
        (Some(rtmp), None) => {
            args.extend(["-f".into(), "flv".into(), rtmp.to_string()]);
            Ok(())
        }
        (None, Some(path)) => {
            args.extend([
                "-movflags".into(),
                "+frag_keyframe+empty_moov".into(),
                "-f".into(),
                "mp4".into(),
                path_arg(path),
            ]);
            Ok(())
        }
        (Some(rtmp), Some(path)) => {
            args.extend(["-f".into(), "tee".into(), tee_outputs(rtmp, path)]);
            Ok(())
        }
    }
}

fn path_arg(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn tee_outputs(rtmp: &str, path: &Path) -> String {
    let file = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    format!(
        "[f=flv:onfail=ignore]{rtmp}|[f=mp4:onfail=ignore:movflags=+frag_keyframe+empty_moov]{file}"
    )
}

fn dshow_input(video: &str, audio: Option<&str>) -> String {
    match audio {
        Some(audio) if !audio.is_empty() => format!("video={video}:audio={audio}"),
        _ => format!("video={video}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        StreamEncodeRequest, VideoEncoder, build_ffmpeg_args, join_rtmp_url,
    };
    use std::path::PathBuf;

    #[test]
    fn join_rtmp_url_should_append_youtube_key() {
        let url = join_rtmp_url("rtmps://a.rtmps.youtube.com/live2", "abc-key").unwrap();
        assert_eq!(url, "rtmps://a.rtmps.youtube.com/live2/abc-key");
    }

    #[test]
    fn join_rtmp_url_should_reject_non_rtmp() {
        let err = join_rtmp_url("https://youtube.com", "key").unwrap_err();
        assert!(err.contains("rtmp"));
    }

    #[test]
    fn join_rtmp_url_should_keep_trailing_slash() {
        let url = join_rtmp_url("rtmp://live.example.com/app/", "stream-key").unwrap();
        assert_eq!(url, "rtmp://live.example.com/app/stream-key");
    }

    #[test]
    fn build_ffmpeg_args_should_use_dshow_for_camo() {
        let args = build_ffmpeg_args(&StreamEncodeRequest {
            video_device: Some("Camo Camera".into()),
            audio_device: Some("Microphone (USB)".into()),
            overlay_path: Some(PathBuf::from("C:/overlay.png")),
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: 4500,
            encoder: VideoEncoder::X264,
            destination: Some("rtmps://a.rtmps.youtube.com/live2/key".into()),
            record_path: None,
        })
        .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "dshow"]));
        assert!(args
            .iter()
            .any(|arg| arg.contains("video=Camo Camera:audio=Microphone (USB)")));
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"aac".to_string()));
        assert_eq!(
            args.last().unwrap(),
            "rtmps://a.rtmps.youtube.com/live2/key"
        );
    }

    #[test]
    fn build_ffmpeg_args_should_write_a_local_mp4_without_rtmp() {
        let args = build_ffmpeg_args(&StreamEncodeRequest {
            video_device: Some("Iriun Webcam".into()),
            audio_device: Some("Microphone (Iriun Webcam)".into()),
            overlay_path: None,
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: 4500,
            encoder: VideoEncoder::X264,
            destination: None,
            record_path: Some(PathBuf::from("C:/Rhema/videos/service/program.mp4")),
        })
        .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "mp4"]));
        assert!(args
            .iter()
            .any(|arg| arg.ends_with("program.mp4")));
        assert!(!args.iter().any(|arg| arg.contains("rtmp")));
    }
}
