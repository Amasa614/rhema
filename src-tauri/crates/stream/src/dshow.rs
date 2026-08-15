use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshowDevices {
    pub video: Vec<String>,
    pub audio: Vec<String>,
}

/// Parse `ffmpeg -f dshow -list_devices true -i dummy` stderr into device names.
///
/// Newer FFmpeg prints `"Name" (video)` / `"Name" (audio)` without section
/// headers. Older builds still use "DirectShow video devices" blocks.
pub fn parse_dshow_devices(output: &str) -> DshowDevices {
    let mut devices = DshowDevices::default();
    let mut section: Option<&str> = None;

    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("alternative name") {
            continue;
        }
        if lower.contains("video devices") && !lower.contains("(video)") {
            section = Some("video");
            continue;
        }
        if lower.contains("audio devices") && !lower.contains("(audio)") {
            section = Some("audio");
            continue;
        }

        let kind = if lower.contains("(video)") {
            "video"
        } else if lower.contains("(audio)") {
            "audio"
        } else {
            match section {
                Some(kind) => kind,
                None => continue,
            }
        };
        let Some(name) = quoted_device_name(line) else {
            continue;
        };
        push_unique(match kind {
            "audio" => &mut devices.audio,
            _ => &mut devices.video,
        }, name);
    }

    devices
}

fn push_unique(list: &mut Vec<String>, name: String) {
    if !list.iter().any(|existing| existing == &name) {
        list.push(name);
    }
}

fn quoted_device_name(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    let name = rest[..end].trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_dshow_devices;

    const SAMPLE: &str = r#"
[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001]  "Camo Camera"
[dshow @ 000001]     Alternative name "@device_pnp_\\?\camo"
[dshow @ 000001]  "Iriun Webcam"
[dshow @ 000001]     Alternative name "@device_pnp_\\?\iriun"
[dshow @ 000001]  "Integrated Camera"
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  "Microphone (Realtek(R) Audio)"
[dshow @ 000001]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave"
"#;

    #[test]
    fn parse_dshow_devices_should_list_camo_and_iriun_as_video() {
        let devices = parse_dshow_devices(SAMPLE);
        assert_eq!(
            devices.video,
            vec!["Camo Camera", "Iriun Webcam", "Integrated Camera"]
        );
    }

    #[test]
    fn parse_dshow_devices_should_list_audio_separately() {
        let devices = parse_dshow_devices(SAMPLE);
        assert_eq!(devices.audio, vec!["Microphone (Realtek(R) Audio)"]);
    }

    const FFMPEG7: &str = r#"
[dshow @ 00000270ae88b3c0] "Integrated Webcam" (video)
[dshow @ 00000270ae88b3c0]   Alternative name "@device_pnp_\\?\usb#vid_0bda"
[dshow @ 00000270ae88b3c0] "Iriun Webcam" (video)
[dshow @ 00000270ae88b3c0]   Alternative name "@device_pnp_\\?\root#devgen"
[dshow @ 00000270ae88b3c0] "Microphone (Iriun Webcam)" (audio)
[dshow @ 00000270ae88b3c0]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave"
Error opening input file dummy.
"#;

    #[test]
    fn parse_dshow_devices_should_read_ffmpeg7_tagged_names() {
        let devices = parse_dshow_devices(FFMPEG7);
        assert_eq!(
            devices.video,
            vec!["Integrated Webcam", "Iriun Webcam"]
        );
        assert_eq!(devices.audio, vec!["Microphone (Iriun Webcam)"]);
    }
}
