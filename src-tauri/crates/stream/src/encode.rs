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
    /// OBS-style: program frames arrive on ffmpeg stdin as MJPEG.
    pub video_from_stdin: bool,
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
    // pad/scale take width:height. pad=1920x1080 is parsed as an expression and fails
    // with "Invalid chars 'x1080'".
    let filter_size = format!("{}:{}", request.width, request.height);

    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "warning".into()];
    let mut next_input: u32 = 0;
    let video_input: u32;

    if request.video_from_stdin {
        args.extend([
            "-f".into(),
            "mjpeg".into(),
            "-framerate".into(),
            fps.to_string(),
            "-i".into(),
            "pipe:0".into(),
        ]);
        video_input = next_input;
        next_input += 1;
    } else if let Some(overlay) = &request.overlay_path {
        args.extend([
            "-f".into(),
            "image2".into(),
            "-loop".into(),
            "1".into(),
            "-framerate".into(),
            fps.to_string(),
            "-i".into(),
            overlay.to_string_lossy().into_owned(),
        ]);
        video_input = next_input;
        next_input += 1;
    } else if let Some(video) = request.video_device.as_deref() {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-rtbufsize".into(),
            "256M".into(),
            "-thread_queue_size".into(),
            "512".into(),
            "-i".into(),
            dshow_input(video, None),
        ]);
        video_input = next_input;
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

    let audio_input = if let Some(audio) = request
        .audio_device
        .as_deref()
        .filter(|name| !is_phone_virtual_device(name))
    {
        args.extend([
            "-f".into(),
            "dshow".into(),
            "-thread_queue_size".into(),
            "512".into(),
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
            "anullsrc=channel_layout=stereo:sample_rate=44100".into(),
        ]);
        let index = next_input;
        Some(index)
    };
    let _ = next_input;

    let filter = format!(
        "[{video_input}:v]scale={filter_size}:force_original_aspect_ratio=decrease,pad={filter_size}:(ow-iw)/2:(oh-ih)/2,fps={fps},format=yuv420p[base]"
    );

    args.extend(["-filter_complex".into(), filter]);
    args.extend(["-map".into(), "[base]".into()]);
    args.extend([
        "-map".into(),
        format!("{}:a", audio_input.unwrap_or(0)),
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
                "-rc".into(),
                "cbr".into(),
                "-profile:v".into(),
                "main".into(),
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
                "-profile:v".into(),
                "main".into(),
                "-level".into(),
                "4.1".into(),
                "-sc_threshold".into(),
                "0".into(),
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
        "44100".into(),
        "-ac".into(),
        "2".into(),
    ]);
    // FLV/RTMP (Facebook, YouTube) needs global headers. Direct `-f flv` sets
    // this automatically; `-f tee` does not, so Facebook ingest gets no packets.
    // https://stackoverflow.com/questions/43968879
    if request.destination.is_some() && request.record_path.is_some() {
        args.extend(["-flags".into(), "+global_header".into()]);
    }
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
            args.extend([
                "-flvflags".into(),
                "no_duration_filesize".into(),
                "-f".into(),
                "flv".into(),
                rtmp.to_string(),
            ]);
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

fn is_phone_virtual_device(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("iriun") || lower.contains("camo")
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
    fn build_ffmpeg_args_should_use_program_png_when_overlay_present() {
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
            video_from_stdin: true,
        })
        .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "mjpeg"]));
        assert!(args.iter().any(|arg| arg == "pipe:0"));
        assert!(args.windows(2).any(|pair| pair == ["-flvflags", "no_duration_filesize"]));
        assert!(args.windows(2).any(|pair| pair == ["-profile:v", "main"]));
        assert!(!args.iter().any(|arg| arg.contains("video=Camo Camera")));
        assert!(args.iter().any(|arg| arg == "audio=Microphone (USB)"));
        assert!(args.contains(&"libx264".to_string()));
        assert!(args.iter().any(|arg| arg.contains("scale=1920:1080")));
        assert!(args.iter().any(|arg| arg.contains("pad=1920:1080")));
        assert!(!args.iter().any(|arg| arg.contains("pad=1920x1080")));
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
            video_from_stdin: false,
        })
        .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "mp4"]));
        assert!(args
            .iter()
            .any(|arg| arg.ends_with("program.mp4")));
        assert!(!args.iter().any(|arg| arg.contains("rtmp")));
        assert!(args.iter().any(|arg| arg == "video=Iriun Webcam"));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("audio=Microphone (Iriun Webcam)")));
        assert!(args.iter().any(|arg| arg.contains("anullsrc")));
    }

    #[test]
    fn build_ffmpeg_args_should_set_global_header_for_tee() {
        let args = build_ffmpeg_args(&StreamEncodeRequest {
            video_device: Some("Iriun Webcam".into()),
            audio_device: None,
            overlay_path: None,
            width: 1920,
            height: 1080,
            fps: 30,
            video_bitrate_kbps: 4500,
            encoder: VideoEncoder::X264,
            destination: Some("rtmps://live-api-s.facebook.com:443/rtmp/key".into()),
            record_path: Some(PathBuf::from("C:/Rhema/videos/service/program.mp4")),
            video_from_stdin: false,
        })
        .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-flags", "+global_header"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "tee"]));
    }
}
