/// Strip RTMP destinations and stream keys from FFmpeg stderr before it
/// reaches logs, toasts, or `stream:status` events.
pub fn sanitize_ffmpeg_error(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("FFmpeg exited unexpectedly");
    classify_ffmpeg_message(&redact_rtmp_urls(line))
}

pub fn sanitize_ffmpeg_error_with_key(stderr: &str, stream_key: &str) -> String {
    sanitize_ffmpeg_error_with_redactions(stderr, &[stream_key])
}

pub fn sanitize_ffmpeg_error_with_redactions<T: AsRef<str>>(
    stderr: &str,
    redactions: &[T],
) -> String {
    let mut cleaned = sanitize_ffmpeg_error(stderr);
    for token in redactions {
        let token = token.as_ref().trim();
        if !token.is_empty() {
            cleaned = cleaned.replace(token, "[stream key]");
        }
    }
    cleaned
}

fn redact_rtmp_urls(text: &str) -> String {
    let mut out = text.to_string();
    loop {
        let lower = out.to_ascii_lowercase();
        let start = match lower
            .find("rtmps://")
            .or_else(|| lower.find("rtmp://"))
        {
            Some(index) => index,
            None => break,
        };
        let end = out[start..]
            .find(char::is_whitespace)
            .map_or(out.len(), |offset| start + offset);
        out.replace_range(start..end, "[rtmp destination]");
    }
    out
}

fn classify_ffmpeg_message(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
    {
        return "Stream server rejected the connection. Check the stream key.".into();
    }
    if lower.contains("connection refused") {
        return "Could not connect to the stream server.".into();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "Timed out connecting to the stream server.".into();
    }
    if lower.contains("i/o error") || lower.contains("error number -10053") {
        return "The stream connection was interrupted.".into();
    }
    if lower.contains("busy") || lower.contains("in use") || lower.contains("already used") {
        return "Camera or microphone is already in use. Close other apps using it.".into();
    }
    line.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        sanitize_ffmpeg_error, sanitize_ffmpeg_error_with_key, sanitize_ffmpeg_error_with_redactions,
    };

    #[test]
    fn sanitize_ffmpeg_error_should_redact_rtmp_urls() {
        let cleaned = sanitize_ffmpeg_error(
            "Opening rtmps://a.rtmps.youtube.com/live2/secret-key-123 for output",
        );
        assert!(!cleaned.contains("secret-key-123"));
        assert!(!cleaned.to_ascii_lowercase().contains("rtmps://"));
        assert!(cleaned.contains("[rtmp destination]"));
    }

    #[test]
    fn sanitize_ffmpeg_error_should_redact_uppercase_rtmp_urls() {
        let cleaned = sanitize_ffmpeg_error("Failed RTMP://live.example.com/app/key-value");
        assert!(!cleaned.contains("key-value"));
        assert!(!cleaned.to_ascii_lowercase().contains("rtmp://"));
    }

    #[test]
    fn sanitize_ffmpeg_error_with_key_should_redact_bare_key() {
        let cleaned = sanitize_ffmpeg_error_with_key(
            "Server returned 5xx for secret-key-123",
            "secret-key-123",
        );
        assert!(!cleaned.contains("secret-key-123"));
    }

    #[test]
    fn sanitize_ffmpeg_error_should_map_auth_failures() {
        let cleaned = sanitize_ffmpeg_error(
            "Server returned 403 Forbidden (access denied) for rtmp://live.example.com/app/the-key",
        );
        assert_eq!(
            cleaned,
            "Stream server rejected the connection. Check the stream key."
        );
        assert!(!cleaned.contains("the-key"));
    }

    #[test]
    fn sanitize_ffmpeg_error_should_map_connection_refused() {
        let cleaned = sanitize_ffmpeg_error("Connection refused");
        assert_eq!(cleaned, "Could not connect to the stream server.");
    }

    #[test]
    fn sanitize_ffmpeg_error_with_redactions_should_strip_all_tokens() {
        let cleaned = sanitize_ffmpeg_error_with_redactions(
            "encoder failed for abc-key leftover",
            &["abc-key"],
        );
        assert!(!cleaned.contains("abc-key"));
        assert!(cleaned.contains("[stream key]"));
    }
}
