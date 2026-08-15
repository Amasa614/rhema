//! Live RTMP encoder helpers for Rhema.
//!
//! Builds FFmpeg arguments and parses DirectShow device lists. Process
//! lifecycle stays in the Tauri command layer so this crate stays UI-free.

mod dshow;
mod encode;
mod sanitize;

pub use dshow::{parse_dshow_devices, DshowDevices};
pub use encode::{
    build_ffmpeg_args, join_rtmp_url, StreamEncodeRequest, VideoEncoder,
};
pub use sanitize::{
    sanitize_ffmpeg_error, sanitize_ffmpeg_error_with_key, sanitize_ffmpeg_error_with_redactions,
};
